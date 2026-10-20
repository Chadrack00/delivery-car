"""Streaming queries over the cleaned LaDe CSV files."""

from collections import Counter, defaultdict
from datetime import date, timedelta
from functools import lru_cache
import json
import math
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import numpy as np
import pandas as pd
from django.conf import settings


DATASETS = {"pickup", "delivery"}
CITY_CODES = {"sh", "hz", "cq", "jl", "yt"}
VARIABLES = {"region_id", "courier_id", "aoi_id"}
DEFAULT_START = "2022-05-01"
DEFAULT_END = "2022-10-31"
CHUNK_SIZE = 100_000
TASK_PAGE_SIZE = 100

EVENT_COLUMN = {"pickup": "pickup_time", "delivery": "delivery_time"}
GPS_COLUMNS = {
    "pickup": ["accept_gps_lng", "accept_gps_lat", "pickup_gps_lng", "pickup_gps_lat"],
    "delivery": ["accept_gps_lng", "accept_gps_lat", "delivery_gps_lng", "delivery_gps_lat"],
}


class QueryError(ValueError):
    pass


def source_path(dataset, city):
    if dataset not in DATASETS:
        raise QueryError("Type de tâche invalide.")
    if city not in CITY_CODES:
        raise QueryError("Ville invalide.")
    path = settings.BASE_DIR / "data" / "processed" / dataset / f"{dataset}_{city}.csv"
    if not path.is_file():
        raise QueryError(f"Fichier de données absent : {path.relative_to(settings.BASE_DIR)}")
    return path


def parse_date_range(start, end):
    try:
        start_date = date.fromisoformat(start or DEFAULT_START)
        end_date = date.fromisoformat(end or DEFAULT_END)
    except ValueError as exc:
        raise QueryError("Dates invalides.") from exc
    if end_date < start_date:
        raise QueryError("La date de fin doit être postérieure ou égale à la date de début.")
    return pd.Timestamp(start_date), pd.Timestamp(end_date + timedelta(days=1))


def file_signature(path):
    stat = path.stat()
    return stat.st_mtime_ns, stat.st_size


def _read_chunks(path, columns):
    try:
        yield from pd.read_csv(
            path,
            usecols=lambda column: column in columns,
            dtype="string",
            chunksize=CHUNK_SIZE,
        )
    except ValueError as exc:
        raise QueryError(f"Le fichier {path.name} ne contient pas les colonnes attendues.") from exc


def _filter_dates(chunk, start, end_exclusive):
    if "accept_time" not in chunk.columns:
        raise QueryError("La colonne accept_time est absente des données traitées.")
    accepted = pd.to_datetime(chunk["accept_time"], format="%Y-%m-%d %H:%M:%S", errors="coerce")
    mask = accepted.ge(start) & accepted.lt(end_exclusive)
    filtered = chunk.loc[mask].copy()
    filtered["_accepted_at"] = accepted.loc[mask]
    return filtered


def _clean_string(value):
    if pd.isna(value):
        return None
    return str(value)


def _number(value):
    parsed = pd.to_numeric(value, errors="coerce")
    if pd.isna(parsed) or not np.isfinite(parsed):
        return None
    return float(parsed)


def _duration_minutes(start_values, end_values):
    start = pd.to_datetime(start_values, format="%Y-%m-%d %H:%M:%S", errors="coerce")
    end = pd.to_datetime(end_values, format="%Y-%m-%d %H:%M:%S", errors="coerce")
    return (end - start).dt.total_seconds() / 60


@lru_cache(maxsize=48)
def _options_cached(dataset, city, start_text, end_text, variable, signature):
    del signature
    path = source_path(dataset, city)
    start, end_exclusive = parse_date_range(start_text, end_text)
    counts = Counter()
    city_total_rows = 0
    total_rows = 0
    missing_courier_rows = 0
    columns = ["accept_time", variable, "courier_id"]
    for chunk in _read_chunks(path, columns):
        city_total_rows += len(chunk)
        chunk = _filter_dates(chunk, start, end_exclusive)
        total_rows += len(chunk)
        courier = chunk["courier_id"].astype("string").str.strip()
        missing_courier_rows += int((courier.isna() | courier.eq("")).sum())
        counts.update(chunk[variable].dropna().astype(str).value_counts().to_dict())
    options = [{"value": value, "count": count} for value, count in counts.items()]
    options.sort(key=lambda item: _natural_key(item["value"]))
    return options, city_total_rows, total_rows, missing_courier_rows


def _natural_key(value):
    try:
        return (0, float(value))
    except (TypeError, ValueError):
        return (1, str(value).casefold())


def get_options(dataset, city, start, end, variable):
    if variable not in VARIABLES:
        raise QueryError("Variable de regroupement invalide.")
    path = source_path(dataset, city)
    start_range, end_range = parse_date_range(start, end)
    options, city_total_rows, total_rows, missing_courier_rows = _options_cached(
        dataset, city, start_range.strftime("%Y-%m-%d"),
        (end_range - pd.Timedelta(days=1)).strftime("%Y-%m-%d"),
        variable, file_signature(path),
    )
    return {
        "options": options,
        "city_total_rows": city_total_rows,
        "total_rows": total_rows,
        "courier_missing_rows": missing_courier_rows,
        "courier_missing_percent": round(100 * missing_courier_rows / total_rows, 2) if total_rows else 0,
    }


@lru_cache(maxsize=64)
def get_entity_analysis(dataset, city, start_text, end_text, variable, selected_value, page, signature):
    del signature
    if variable not in VARIABLES:
        raise QueryError("Variable de regroupement invalide.")
    path = source_path(dataset, city)
    start, end_exclusive = parse_date_range(start_text, end_text)
    event_column = EVENT_COLUMN[dataset]
    time_columns = ["accept_time", event_column]
    if dataset == "pickup":
        time_columns.append("time_window_start")
    needed = [
        "order_id", variable, "accept_time", event_column, "lng", "lat",
        *GPS_COLUMNS[dataset], *time_columns,
    ]
    duration_values = []
    status_counts = Counter()
    records = []
    total = 0
    page_start = (page - 1) * TASK_PAGE_SIZE

    for chunk in _read_chunks(path, needed):
        chunk = _filter_dates(chunk, start, end_exclusive)
        chunk = chunk.loc[chunk[variable].astype("string") == str(selected_value)]
        if chunk.empty:
            continue
        chunk_start = total
        total += len(chunk)
        durations = _duration_minutes(chunk["accept_time"], chunk[event_column])
        duration_values.extend(durations.dropna().tolist())

        statuses = pd.Series(index=chunk.index, dtype="Int64")
        if dataset == "pickup":
            event_time = pd.to_datetime(chunk[event_column], format="%Y-%m-%d %H:%M:%S", errors="coerce")
            window_start = pd.to_datetime(chunk["time_window_start"], format="%Y-%m-%d %H:%M:%S", errors="coerce")
            valid_status = event_time.notna() & window_start.notna()
            # Suit la formule de la consigne : status 0 lorsque window_start - pickup_time > 0.
            statuses.loc[valid_status] = (window_start.loc[valid_status] <= event_time.loc[valid_status]).astype(int)
            status_counts.update(statuses.dropna().astype(int).value_counts().to_dict())

        local_start = max(0, page_start - chunk_start)
        local_end = min(len(chunk), page_start + TASK_PAGE_SIZE - chunk_start)
        page_slice = chunk.iloc[local_start:local_end] if local_end > local_start else chunk.iloc[0:0]
        if not page_slice.empty:
            for idx, row in page_slice.iterrows():
                duration = durations.loc[idx]
                status = statuses.loc[idx] if dataset == "pickup" else pd.NA
                record = {
                    "order_id": _clean_string(row.get("order_id")),
                    "accept_time": _clean_string(row.get("accept_time")),
                    "event_time": _clean_string(row.get(event_column)),
                    "duration_min": round(float(duration), 2) if pd.notna(duration) else None,
                    "status": int(status) if pd.notna(status) else None,
                    "task_lng": _number(row.get("lng")),
                    "task_lat": _number(row.get("lat")),
                    "origin_lng": _number(row.get("accept_gps_lng")),
                    "origin_lat": _number(row.get("accept_gps_lat")),
                    "destination_lng": _number(row.get(f"{dataset}_gps_lng")),
                    "destination_lat": _number(row.get(f"{dataset}_gps_lat")),
                }
                records.append(record)

    values = np.asarray(duration_values, dtype=float)
    values = values[np.isfinite(values)]
    duration_summary = {
        "median": round(float(np.median(values)), 2) if values.size else None,
        "q25": round(float(np.percentile(values, 25)), 2) if values.size else None,
        "q75": round(float(np.percentile(values, 75)), 2) if values.size else None,
    }
    return {
        "dataset": dataset,
        "variable": variable,
        "value": selected_value,
        "total": total,
        "duration": duration_summary,
        "status_counts": {str(key): int(status_counts.get(key, 0)) for key in (0, 1)},
        "records": records,
        "page": page,
        "page_size": TASK_PAGE_SIZE,
        "pages": max(1, math.ceil(total / TASK_PAGE_SIZE)),
    }


def entity_analysis(dataset, city, start, end, variable, selected_value, page=1):
    try:
        page = max(1, int(page))
    except (TypeError, ValueError) as exc:
        raise QueryError("Numéro de page invalide.") from exc
    path = source_path(dataset, city)
    start_range, end_range = parse_date_range(start, end)
    return get_entity_analysis(
        dataset, city, start_range.strftime("%Y-%m-%d"),
        (end_range - pd.Timedelta(days=1)).strftime("%Y-%m-%d"),
        variable, str(selected_value), page, file_signature(path),
    )


@lru_cache(maxsize=30)
def _courier_variability_cached(dataset, city, start_text, end_text, signature):
    del signature
    path = source_path(dataset, city)
    start, end_exclusive = parse_date_range(start_text, end_text)
    event_column = EVENT_COLUMN[dataset]
    count_by_courier = Counter()
    durations_by_courier = defaultdict(list)
    for chunk in _read_chunks(path, ["courier_id", "accept_time", event_column]):
        chunk = _filter_dates(chunk, start, end_exclusive)
        chunk = chunk.dropna(subset=["courier_id"])
        if chunk.empty:
            continue
        durations = _duration_minutes(chunk["accept_time"], chunk[event_column])
        valid = durations.notna()
        grouped = chunk.loc[valid].assign(_duration=durations.loc[valid]).groupby("courier_id")["_duration"]
        for courier, values in grouped:
            values = values.to_numpy(dtype=float)
            count_by_courier[str(courier)] += len(values)
            durations_by_courier[str(courier)].extend(values.tolist())

    results = []
    for courier, values in durations_by_courier.items():
        data = np.asarray(values, dtype=float)
        results.append({
            "courier_id": courier,
            "tasks": count_by_courier[courier],
            "total_min": round(float(np.sum(data)), 2),
            "median_min": round(float(np.median(data)), 2),
            "q25_min": round(float(np.percentile(data, 25)), 2),
            "q75_min": round(float(np.percentile(data, 75)), 2),
        })
    results.sort(key=lambda row: (-row["tasks"], _natural_key(row["courier_id"])))
    return results


def courier_variability(dataset, city, start, end):
    path = source_path(dataset, city)
    start_range, end_range = parse_date_range(start, end)
    return _courier_variability_cached(
        dataset, city, start_range.strftime("%Y-%m-%d"),
        (end_range - pd.Timedelta(days=1)).strftime("%Y-%m-%d"), file_signature(path),
    )


def _haversine_km(lon1, lat1, lon2, lat2):
    lon1, lat1, lon2, lat2 = [np.radians(values) for values in (lon1, lat1, lon2, lat2)]
    dlon = lon2 - lon1
    dlat = lat2 - lat1
    a = np.sin(dlat / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlon / 2) ** 2
    return 6371.0088 * 2 * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


@lru_cache(maxsize=24)
def _gps_quality_cached(dataset, city, start_text, end_text, signature):
    del signature
    path = source_path(dataset, city)
    start, end_exclusive = parse_date_range(start_text, end_text)
    event_gps = f"{dataset}_gps_"
    columns = ["accept_time", "lng", "lat", *GPS_COLUMNS[dataset]]
    missing = Counter()
    total = 0
    distance_arrays = []
    for chunk in _read_chunks(path, columns):
        chunk = _filter_dates(chunk, start, end_exclusive)
        total += len(chunk)
        missing_rows = chunk[GPS_COLUMNS[dataset]].isna()
        for column in GPS_COLUMNS[dataset]:
            missing[column] += int(missing_rows[column].sum())

        task_lng = pd.to_numeric(chunk.get("lng"), errors="coerce").to_numpy(dtype=float, na_value=np.nan)
        task_lat = pd.to_numeric(chunk.get("lat"), errors="coerce").to_numpy(dtype=float, na_value=np.nan)
        gps_lng = pd.to_numeric(chunk.get(f"{event_gps}lng"), errors="coerce").to_numpy(dtype=float, na_value=np.nan)
        gps_lat = pd.to_numeric(chunk.get(f"{event_gps}lat"), errors="coerce").to_numpy(dtype=float, na_value=np.nan)
        valid = np.isfinite(task_lng) & np.isfinite(task_lat) & np.isfinite(gps_lng) & np.isfinite(gps_lat)
        valid &= (np.abs(task_lng) <= 180) & (np.abs(gps_lng) <= 180) & (np.abs(task_lat) <= 90) & (np.abs(gps_lat) <= 90)
        if valid.any():
            distances = _haversine_km(task_lng[valid], task_lat[valid], gps_lng[valid], gps_lat[valid])
            distance_arrays.append(distances[np.isfinite(distances)])

    distances = np.concatenate(distance_arrays) if distance_arrays else np.array([], dtype=float)
    if distances.size:
        upper = float(np.percentile(distances, 99))
        upper = max(upper, 0.1)
        histogram_values = distances[distances <= upper]
        counts, edges = np.histogram(histogram_values, bins=18, range=(0, upper))
        bins = [
            {"label": f"{edges[i]:.1f}–{edges[i + 1]:.1f}", "count": int(counts[i])}
            for i in range(len(counts))
        ]
        distance_stats = {
            "valid": int(distances.size),
            "median_km": round(float(np.median(distances)), 3),
            "p90_km": round(float(np.percentile(distances, 90)), 3),
            "p99_km": round(float(np.percentile(distances, 99)), 3),
            "max_km": round(float(np.max(distances)), 3),
        }
    else:
        bins = []
        distance_stats = {"valid": 0, "median_km": None, "p90_km": None, "p99_km": None, "max_km": None}
    missing_stats = [
        {"column": column, "missing": int(missing[column]), "percent": round(100 * missing[column] / total, 2) if total else 0}
        for column in GPS_COLUMNS[dataset]
    ]
    return {"total": total, "missing": missing_stats, "distance": distance_stats, "distance_bins": bins}


def gps_quality(dataset, city, start_text, end_text):
    path = source_path(dataset, city)
    start, end_exclusive = parse_date_range(start_text, end_text)
    return _gps_quality_cached(
        dataset, city, start.strftime("%Y-%m-%d"),
        (end_exclusive - pd.Timedelta(days=1)).strftime("%Y-%m-%d"), file_signature(path),
    )


def fetch_osm_route(origin_lat, origin_lng, destination_lat, destination_lng, dataset_minutes):
    coords = [origin_lat, origin_lng, destination_lat, destination_lng]
    if not all(math.isfinite(float(value)) for value in coords):
        raise QueryError("Coordonnées GPS incomplètes ou invalides.")
    if not (-90 <= float(origin_lat) <= 90 and -90 <= float(destination_lat) <= 90):
        raise QueryError("Latitude hors limites.")
    if not (-180 <= float(origin_lng) <= 180 and -180 <= float(destination_lng) <= 180):
        raise QueryError("Longitude hors limites.")

    if not math.isfinite(float(dataset_minutes)) or float(dataset_minutes) < 0:
        raise QueryError("La durée de la tâche est invalide.")
    coordinates = f"{float(origin_lng)},{float(origin_lat)};{float(destination_lng)},{float(destination_lat)}"
    request = Request(
        f"{settings.OSRM_BASE_URL}/route/v1/driving/{coordinates}?overview=full&geometries=geojson",
        headers={"User-Agent": "LaDe-delivery-anomaly-dashboard/1.0"},
        method="GET",
    )
    try:
        with urlopen(request, timeout=15) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:600]
        raise QueryError(f"Le service OSRM a refusé la requête ({exc.code}) : {detail}") from exc
    except (URLError, TimeoutError) as exc:
        raise QueryError(f"Impossible de joindre le service OSRM : {exc}") from exc
    routes = payload.get("routes", [])
    if payload.get("code") != "Ok" or not routes:
        raise QueryError("OSRM n'a trouvé aucun itinéraire routier pour ces coordonnées.")
    route = routes[0]
    osm_minutes = float(route["duration"]) / 60
    assessment = "Comparaison indicative uniquement."
    if osm_minutes > 0 and float(dataset_minutes) < osm_minutes * 0.8:
        assessment = "Durée observée nettement plus courte que l'estimation OSRM : vérifiez les coordonnées et les horodatages."
    elif osm_minutes > 0 and float(dataset_minutes) > osm_minutes * 3:
        assessment = "Durée observée très supérieure à l'estimation OSRM : vérifiez le temps d'attente, les arrêts et les horodatages."
    return {
        "osm_minutes": round(osm_minutes, 2),
        "osm_distance_km": round(float(route.get("distance", 0)) / 1000, 2),
        "geometry": route.get("geometry"),
        "dataset_minutes": round(float(dataset_minutes), 2),
        "difference_minutes": round(float(dataset_minutes) - osm_minutes, 2),
        "ratio": round(float(dataset_minutes) / osm_minutes, 2) if osm_minutes else None,
        "assessment": assessment,
    }
