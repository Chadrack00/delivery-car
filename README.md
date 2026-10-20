# LaDe — exploration des données de livraison

Ce dépôt contient un tableau de bord Django et des notebooks pour explorer le jeu de données LaDe. Il porte sur les **collectes** (`pickup`) et les **livraisons** (`delivery`) dans cinq villes : Chongqing, Hangzhou, Jilin, Shanghai et Yantai. Les analyses décrivent les volumes, les durées, les créneaux et la disponibilité des coordonnées GPS.

## Télécharger les données nettoyées

Les fichiers CSV sont volumineux et ne sont pas inclus dans Git. Pour lancer le tableau de bord ou les analyses, télécharge l’archive des données nettoyées et conserve son organisation par activité et par ville.

<!-- Remplacer URL_AJOUTER_ICI par le lien public de téléchargement de l’archive. -->

**Téléchargement :** [Jeu de données nettoyé](https://drive.google.com/drive/folders/1iqzdgz1rmoPr9wEtU8VV4fxZWQrWNpGx)

Après extraction à la racine du dépôt, vérifie que les dix fichiers CSV se trouvent ici :

```text
data/processed/
├── delivery/
│   ├── delivery_cq.csv
│   ├── delivery_hz.csv
│   ├── delivery_jl.csv
│   ├── delivery_sh.csv
│   └── delivery_yt.csv
└── pickup/
    ├── pickup_cq.csv
    ├── pickup_hz.csv
    ├── pickup_jl.csv
    ├── pickup_sh.csv
    └── pickup_yt.csv
```

Codes de ville utilisés dans les noms de fichiers : `cq` Chongqing, `hz` Hangzhou, `jl` Jilin, `sh` Shanghai et `yt` Yantai. Si l’archive contient déjà un dossier `data/processed`, extrais-la à la racine du projet pour éviter de créer un chemin imbriqué tel que `data/processed/data/processed/`.

## Installation

Prérequis : Python 3 et `pip`. Depuis la racine du dépôt, crée un environnement virtuel et installe les dépendances :

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
```

Sous Windows, active l’environnement avec `.venv\Scripts\activate` au lieu de `source .venv/bin/activate`.

## Lancer le tableau de bord

Une fois les fichiers nettoyés placés dans `data/processed/`, lance le serveur de développement :

```bash
python manage.py runserver
```

Ouvre ensuite <http://127.0.0.1:8000/>. Le tableau de bord permet de choisir le type de tâche, une ville, une période et un regroupement par coursier (`courier_id`), région (`region_id`) ou zone (`aoi_id`). Il affiche notamment les durées, le classement des collectes par rapport au créneau, les coordonnées GPS manquantes, la répartition des tâches et la variabilité entre coursiers. Les tableaux paginent les tâches par 100 lignes ; les indicateurs sont calculés sur les lignes correspondant aux filtres sélectionnés.

Le tableau propose aussi une comparaison d’itinéraire à la demande. Elle utilise OSRM pour estimer la route entre les coordonnées GPS et OpenFreeMap pour l’afficher sur un fond cartographique basé sur OpenStreetMap. La carte nécessite une connexion internet. Le serveur public OSRM est utilisé par défaut, sans garantie de disponibilité et limité à une requête par seconde ; il est possible de configurer une autre instance :

```bash
export OSRM_BASE_URL="https://router.project-osrm.org"
python manage.py runserver
```

`djangostreetmap` figure dans les dépendances pour une éventuelle installation cartographique en propre, mais le tableau de bord actuel ne l’utilise pas et n’active pas de pipeline PostGIS/GDAL. Le routage et l’affichage décrits ci-dessus passent par OSRM et OpenFreeMap.

## Reproduire les analyses

Le notebook d’exploration après nettoyage lit les CSV de `data/processed/` par blocs. Il calcule les volumes, les taux de coordonnées GPS manquantes, les volumes quotidiens et le respect des créneaux sur l’ensemble des lignes. Les graphiques de durée et de répartition géographique s’appuient sur un échantillon reproductible afin de limiter l’usage de mémoire.

Lance Jupyter depuis la racine du dépôt :

```bash
jupyter notebook data/processed/etat_des_dataset.ipynb
```

Les images et tableaux produits sont enregistrés dans `reports/etat_datasets_nettoye/`. Le rapport descriptif qui les utilise se trouve dans [`rapport_exploration.md`](rapport_exploration.md). Le notebook peut prendre plusieurs minutes pour parcourir tous les CSV.

Les notebooks consacrés aux données avant nettoyage et au prétraitement sont dans `data/raw/` :

- `data/raw/etat_des_dataset.ipynb` décrit l’état des fichiers sources avant nettoyage.
- `data/raw/raison_nettoyage.ipynb` documente les raisons des choix de nettoyage.
- `data/raw/nettoyage.ipynb` transforme les CSV sources de `data/raw/delivery/` et `data/raw/pickup/`, puis écrit les résultats dans `data/processed/` en conservant la structure des dossiers.

Pour relancer le prétraitement, il faut également disposer des CSV bruts dans ces deux dossiers. Le notebook d’exploration après nettoyage n’en a pas besoin. Le rapport du prétraitement est dans [`rapport_pretraitement.md`](rapport_pretraitement.md), et le prompt de préparation des diapositives dans [`prompt_slide.md`](prompt_slide.md).

## Principes de préparation des données

Le nettoyage retire les lignes entièrement vides ainsi que celles qui n’ont aucune coordonnée GPS utile. Pour les collectes, une ligne est gardée dès qu’au moins une coordonnée d’acceptation ou de collecte est renseignée ; la règle équivalente s’applique aux livraisons. Les colonnes redondantes ou non documentées sont écartées, les horodatages sans année reçoivent l’année de référence 2022 et les fichiers sont triés par `accept_time`, de la date la plus récente à la plus ancienne. Le détail des opérations par fichier est disponible dans [`reports/tableau_nettoyage.png`](reports/tableau_nettoyage.png).

Pour les collectes, l’indicateur de créneau vaut **0** si la collecte a lieu avant `time_window_start` et **1** si elle a lieu au début du créneau ou après. Cette convention sert à présenter les répartitions descriptives dans le tableau de bord et les rapports.

## Arborescence utile

```text
app/                         Tableau de bord Django, traitements et interface
dashboard/                   Configuration du projet Django
data/raw/                    Sources brutes et notebooks de prétraitement
data/processed/              CSV nettoyés et notebook d’exploration après nettoyage
reports/                     Tableaux et graphiques générés
rapport_pretraitement.md     Compte rendu du prétraitement
rapport_exploration.md       État descriptif des données nettoyées
prompt_slide.md              Prompt pour générer une présentation
requirements.txt             Dépendances Python
```
