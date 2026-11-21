import os
from typing import Final

CELERY_BROKER_URL: Final = os.environ["REDIS_URL"]
CELERY_RESULT_BACKEND: Final = CELERY_BROKER_URL
CELERY_WORKER_CONCURRENCY: Final = 2
