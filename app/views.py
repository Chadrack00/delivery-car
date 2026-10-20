import json

from django.http import JsonResponse
from django.shortcuts import render
from django.views.decorators.http import require_GET, require_POST

from .services import (
    QueryError,
    courier_variability,
    entity_analysis,
    fetch_osm_route,
    get_options,
    gps_quality,
    parse_date_range,
)


CITY_LABELS = [
    {"code": "sh", "name": "Shanghai"},
    {"code": "hz", "name": "Hangzhou"},
    {"code": "cq", "name": "Chongqing"},
    {"code": "jl", "name": "Jilin"},
    {"code": "yt", "name": "Yantai"},
]


def dashboard(request):
    return render(request, "app/dashboard.html", {"cities": CITY_LABELS})


def _query_params(request):
    dataset = request.GET.get("dataset", "pickup")
    city = request.GET.get("city", "sh")
    start = request.GET.get("start", "2022-05-01")
    end = request.GET.get("end", "2022-10-31")
    parse_date_range(start, end)
    return dataset, city, start, end


@require_GET
def options(request):
    try:
        dataset, city, start, end = _query_params(request)
        variable = request.GET.get("variable", "courier_id")
        result = get_options(dataset, city, start, end, variable)
        result["count"] = len(result["options"])
        return JsonResponse(result)
    except QueryError as exc:
        return JsonResponse({"error": str(exc)}, status=400)


@require_GET
def analysis(request):
    try:
        dataset, city, start, end = _query_params(request)
        panel = request.GET.get("panel", "records")
        if panel == "gps":
            result = gps_quality(dataset, city, start, end)
        elif panel == "couriers":
            result = {"couriers": courier_variability(dataset, city, start, end)}
        elif panel == "records":
            variable = request.GET.get("variable", "courier_id")
            value = request.GET.get("value")
            if not value:
                return JsonResponse({"error": "Sélectionnez une valeur de regroupement."}, status=400)
            result = entity_analysis(dataset, city, start, end, variable, value, request.GET.get("page", 1))
        else:
            return JsonResponse({"error": "Type d'analyse inconnu."}, status=400)
        return JsonResponse(result)
    except QueryError as exc:
        return JsonResponse({"error": str(exc)}, status=400)


@require_POST
def osm_route(request):
    try:
        body = json.loads(request.body.decode("utf-8"))
        dataset_minutes = float(body["dataset_minutes"])
        result = fetch_osm_route(
            body["origin_lat"], body["origin_lng"],
            body["destination_lat"], body["destination_lng"], dataset_minutes,
        )
        return JsonResponse(result)
    except QueryError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        return JsonResponse({"error": f"Données de trajet invalides : {exc}"}, status=400)
