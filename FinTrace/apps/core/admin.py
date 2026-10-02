from django.contrib import admin

from FinTrace.apps.core.infrastructure.models import CurrencyModel, TenantModel


@admin.register(CurrencyModel)
class CurrencyAdmin(admin.ModelAdmin):
    list_display = ("code", "name", "symbol", "decimal_places", "is_active")
    list_filter = ("is_active",)
    search_fields = ("code", "name")


@admin.register(TenantModel)
class TenantAdmin(admin.ModelAdmin):
    list_display = ("slug", "name", "status", "created_at", "updated_at")
    list_filter = ("status",)
    search_fields = ("slug", "name")

