"""
Production monitoring middleware for observability.
"""
from fastapi import FastAPI, Request, Response
import time
import uuid
from loguru import logger
from typing import Callable
import json
from datetime import datetime

# Try to import prometheus_client for metrics
try:
    from prometheus_client import Counter, Histogram, Gauge, generate_latest, CONTENT_TYPE_LATEST
    PROMETHEUS_AVAILABLE = True
except ImportError:
    PROMETHEUS_AVAILABLE = False
    logger.warning("prometheus_client not installed. Metrics endpoint will not be available.")


# Define metrics if Prometheus is available
if PROMETHEUS_AVAILABLE:
    # Request metrics
    http_requests_total = Counter(
        'http_requests_total',
        'Total HTTP requests',
        ['method', 'endpoint', 'status']
    )
    
    http_request_duration_seconds = Histogram(
        'http_request_duration_seconds',
        'HTTP request duration in seconds',
        ['method', 'endpoint'],
        buckets=(0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0)
    )
    
    http_request_size_bytes = Histogram(
        'http_request_size_bytes',
        'HTTP request size in bytes',
        ['method', 'endpoint']
    )
    
    http_response_size_bytes = Histogram(
        'http_response_size_bytes',
        'HTTP response size in bytes',
        ['method', 'endpoint']
    )
    
    # Application metrics
    active_requests = Gauge(
        'active_requests',
        'Number of active requests'
    )
    
    active_sessions = Gauge(
        'active_sessions',
        'Number of active user sessions'
    )
    
    llm_requests_total = Counter(
        'llm_requests_total',
        'Total requests to LLM providers',
        ['provider', 'model', 'status']
    )
    
    llm_request_duration_seconds = Histogram(
        'llm_request_duration_seconds',
        'LLM request duration in seconds',
        ['provider', 'model']
    )


def add_monitoring_middleware(app: FastAPI):
    """
    Add comprehensive monitoring middleware to FastAPI app.
    Tracks metrics, logs requests, and adds request IDs for tracing.
    """
    
    @app.middleware("http")
    async def monitoring_middleware(request: Request, call_next: Callable) -> Response:
        """
        Monitor each request with metrics and structured logging.
        """
        # Generate request ID for distributed tracing
        request_id = str(uuid.uuid4())
        request.state.request_id = request_id
        
        # Start timing
        start_time = time.time()
        
        # Get request size
        content_length = request.headers.get("content-length")
        request_size = int(content_length) if content_length else 0
        
        # Increment active requests
        if PROMETHEUS_AVAILABLE:
            active_requests.inc()
        
        # Prepare logging context
        log_context = {
            "request_id": request_id,
            "method": request.method,
            "path": request.url.path,
            "client_host": request.client.host if request.client else "unknown",
            "user_agent": request.headers.get("user-agent", "unknown"),
            "request_size": request_size,
        }
        
        # Log request start with context
        with logger.contextualize(**log_context):
            logger.info(f"Request started: {request.method} {request.url.path}")
            
            try:
                # Process request
                response = await call_next(request)
                
                # Calculate metrics
                duration = time.time() - start_time
                
                # Get response size from content-length header
                response_size = 0
                if hasattr(response, "headers"):
                    content_length = response.headers.get("content-length")
                    response_size = int(content_length) if content_length else 0
                
                # Record metrics if Prometheus is available
                if PROMETHEUS_AVAILABLE:
                    # Normalize endpoint for metrics (remove path parameters)
                    endpoint = normalize_endpoint(request.url.path)
                    
                    http_requests_total.labels(
                        method=request.method,
                        endpoint=endpoint,
                        status=response.status_code
                    ).inc()
                    
                    http_request_duration_seconds.labels(
                        method=request.method,
                        endpoint=endpoint
                    ).observe(duration)
                    
                    if request_size > 0:
                        http_request_size_bytes.labels(
                            method=request.method,
                            endpoint=endpoint
                        ).observe(request_size)
                    
                    if response_size > 0:
                        http_response_size_bytes.labels(
                            method=request.method,
                            endpoint=endpoint
                        ).observe(response_size)
                
                # Add request ID to response headers for tracing
                response.headers["X-Request-ID"] = request_id
                response.headers["X-Response-Time"] = f"{duration:.3f}"
                
                # Log completion
                logger.info(
                    f"Request completed: {request.method} {request.url.path}",
                    extra={
                        "status_code": response.status_code,
                        "duration_seconds": round(duration, 4),
                        "response_size": response_size,
                    }
                )
                
                return response
                
            except Exception as e:
                duration = time.time() - start_time
                
                # Record error metrics
                if PROMETHEUS_AVAILABLE:
                    endpoint = normalize_endpoint(request.url.path)
                    http_requests_total.labels(
                        method=request.method,
                        endpoint=endpoint,
                        status=500
                    ).inc()
                
                # Log error
                logger.error(
                    f"Request failed: {request.method} {request.url.path}",
                    extra={
                        "error": str(e),
                        "error_type": type(e).__name__,
                        "duration_seconds": round(duration, 4),
                    },
                    exc_info=True
                )
                
                raise
                
            finally:
                # Decrement active requests
                if PROMETHEUS_AVAILABLE:
                    active_requests.dec()
    
    # Add metrics endpoint if Prometheus is available
    if PROMETHEUS_AVAILABLE:
        @app.get("/metrics", include_in_schema=False, tags=["monitoring"])
        async def metrics():
            """
            Prometheus metrics endpoint.
            Exposes application metrics in Prometheus format.
            """
            return Response(
                content=generate_latest(),
                media_type=CONTENT_TYPE_LATEST,
                headers={
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache",
                    "Expires": "0"
                }
            )
    
    # Add health metrics endpoint
    @app.get("/health/metrics", include_in_schema=False, tags=["monitoring"])
    async def health_metrics():
        """
        Health metrics endpoint for monitoring dashboards.
        Returns current application metrics in JSON format.
        """
        metrics = {
            "timestamp": datetime.utcnow().isoformat(),
            "status": "healthy",
            "metrics": {}
        }
        
        if PROMETHEUS_AVAILABLE:
            # Get current metric values
            metrics["metrics"]["active_requests"] = active_requests._value.get()
            metrics["metrics"]["active_sessions"] = active_sessions._value.get()
        
        return metrics


def normalize_endpoint(path: str) -> str:
    """
    Normalize endpoint path for metrics by replacing path parameters.
    This prevents metric cardinality explosion.
    
    Examples:
    - /api/users/123 -> /api/users/{id}
    - /api/sessions/abc-def -> /api/sessions/{id}
    """
    # Common patterns to normalize
    import re
    
    # UUID pattern
    path = re.sub(r'/[a-f0-9\-]{36}', '/{id}', path)
    
    # Numeric IDs
    path = re.sub(r'/\d+', '/{id}', path)
    
    # Session IDs (alphanumeric with underscores)
    path = re.sub(r'/[a-zA-Z0-9_\-]{8,}', '/{id}', path)
    
    return path


# Export functions for updating custom metrics
def record_llm_request(provider: str, model: str, duration: float, success: bool):
    """Record metrics for an LLM request."""
    if PROMETHEUS_AVAILABLE:
        status = "success" if success else "error"
        llm_requests_total.labels(
            provider=provider,
            model=model,
            status=status
        ).inc()
        
        if duration > 0:
            llm_request_duration_seconds.labels(
                provider=provider,
                model=model
            ).observe(duration)


def update_active_sessions(count: int):
    """Update the active sessions gauge."""
    if PROMETHEUS_AVAILABLE:
        active_sessions.set(count) 