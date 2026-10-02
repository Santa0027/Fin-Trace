from django.http import JsonResponse
from django.db import connection
from django.views import View

class LiveView(View):
    def get(self, request):
        return JsonResponse({"status": "live"}, status=200)

class ReadyView(View):
    def get(self, request):
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1 FROM fintrace.tenants LIMIT 1")
                cursor.fetchone()
            return JsonResponse({"status": "ready"}, status=200)
        except Exception:
            return JsonResponse({"status": "not ready"}, status=503)
