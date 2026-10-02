import json
from uuid import UUID

from django.contrib.auth import authenticate, login, logout
from django.http import JsonResponse
from django.views import View
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import ensure_csrf_cookie

from FinTrace.apps.core.infrastructure.database.utils import DatabaseExecutor

def _json_body(request):
    try:
        return json.loads(request.body.decode("utf-8") or "{}")
    except json.JSONDecodeError:
        return {}


class LoginView(View):
    @method_decorator(ensure_csrf_cookie)
    def post(self, request):
        data = _json_body(request)
        username = data.get("email") or data.get("username")
        password = data.get("password")
        
        if not username or not password:
            return JsonResponse({"error": {"code": "invalid_credentials", "message": "Username and password required"}}, status=400)
            
        user = authenticate(request, username=username, password=password)
        
        if user is None:
            return JsonResponse({"error": {"code": "invalid_credentials", "message": "Invalid username or password"}}, status=401)
            
        if not user.is_active:
            return JsonResponse({"error": {"code": "inactive_user", "message": "User account is inactive"}}, status=403)
            
        login(request, user)
        
        # Load user's companies to set a default if none is active
        companies_query = """
            SELECT t.id, t.slug, t.name
            FROM fintrace.tenants t
            JOIN fintrace.tenant_memberships tm ON tm.tenant_id = t.id
            WHERE tm.user_id = %s AND tm.status = 'ACTIVE'
        """
        companies = DatabaseExecutor().fetch_all(companies_query, [user.id])
        
        if companies and not request.session.get("active_company_id"):
            request.session["active_company_id"] = str(companies[0]["id"])
            
        return JsonResponse({"message": "Logged in successfully"})


class LogoutView(View):
    def post(self, request):
        logout(request)
        return JsonResponse({"message": "Logged out successfully"})


class MeView(View):
    @method_decorator(ensure_csrf_cookie)
    def get(self, request):
        if not request.user.is_authenticated:
            return JsonResponse({"authenticated": False}, status=401)
            
        user_data = {
            "id": request.user.id,
            "username": request.user.username,
            "email": request.user.email,
            "first_name": request.user.first_name,
            "last_name": request.user.last_name
        }
        
        active_company_id = request.session.get("active_company_id")
        tenant_data = None
        
        if active_company_id:
            query = "SELECT id, slug, name FROM fintrace.tenants WHERE id = %s"
            company = DatabaseExecutor().fetch_all(query, [active_company_id])
            if company:
                tenant_data = {
                    "company_id": company[0]["id"],
                    "company_slug": company[0]["slug"],
                    "company_name": company[0]["name"]
                }
                
        return JsonResponse({
            "authenticated": True,
            "user": user_data,
            "tenant": tenant_data,
            "platform": {
                "is_superuser": request.user.is_superuser,
                "is_staff": request.user.is_staff
            }
        })


class CompaniesView(View):
    def get(self, request):
        if not request.user.is_authenticated:
            return JsonResponse({"error": "Unauthorized"}, status=401)
            
        if request.user.is_superuser:
            query = "SELECT id, slug, name, status FROM fintrace.tenants WHERE status = 'ACTIVE' ORDER BY name"
            companies = DatabaseExecutor().fetch_all(query, [])
        else:
            query = """
                SELECT t.id, t.slug, t.name, t.status
                FROM fintrace.tenants t
                JOIN fintrace.tenant_memberships tm ON tm.tenant_id = t.id
                WHERE tm.user_id = %s AND tm.status = 'ACTIVE' AND t.status = 'ACTIVE'
                ORDER BY t.name
            """
            companies = DatabaseExecutor().fetch_all(query, [request.user.id])
            
        return JsonResponse({"companies": companies})


class SwitchTenantView(View):
    def post(self, request):
        if not request.user.is_authenticated:
            return JsonResponse({"error": "Unauthorized"}, status=401)
            
        data = _json_body(request)
        company_id = data.get("company_id")
        
        if not company_id:
            return JsonResponse({"error": "company_id required"}, status=400)
            
        # Verify access
        if request.user.is_superuser:
            query = "SELECT id, name FROM fintrace.tenants WHERE id = %s AND status = 'ACTIVE'"
            company = DatabaseExecutor().fetch_all(query, [company_id])
        else:
            query = """
                SELECT t.id, t.name
                FROM fintrace.tenants t
                JOIN fintrace.tenant_memberships tm ON tm.tenant_id = t.id
                WHERE t.id = %s AND tm.user_id = %s AND tm.status = 'ACTIVE' AND t.status = 'ACTIVE'
            """
            company = DatabaseExecutor().fetch_all(query, [company_id, request.user.id])
            
        if not company:
            return JsonResponse({"error": {"code": "forbidden", "message": "Access to this company is denied or company does not exist"}}, status=403)
            
        # Update session
        request.session["active_company_id"] = str(company[0]["id"])
        
        return JsonResponse({
            "message": "Tenant switched successfully",
            "tenant": {
                "company_id": company[0]["id"],
                "company_name": company[0]["name"]
            }
        })

class CsrfView(View):
    @method_decorator(ensure_csrf_cookie)
    def get(self, request):
        return JsonResponse({"csrf": "ready"})
