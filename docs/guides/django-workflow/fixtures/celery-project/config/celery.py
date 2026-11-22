from celery import Celery

app = Celery("config")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks()


@app.task
def add(left: int, right: int) -> int:
    return left + right
