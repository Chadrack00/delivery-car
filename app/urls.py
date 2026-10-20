from django.urls import path

from . import views

urlpatterns = [
    path("", views.dashboard, name="dashboard"),
    path("api/options/", views.options, name="options"),
    path("api/analysis/", views.analysis, name="analysis"),
    path("api/osm-route/", views.osm_route, name="osm-route"),
]
