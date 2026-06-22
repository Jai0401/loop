"""Loop entrypoint. Loads .env, configures logging, starts the Slack app."""
from __future__ import annotations

import logging
import os

from dotenv import load_dotenv


def main() -> None:
    load_dotenv()

    level = os.environ.get("LOG_LEVEL", "INFO").upper()
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    from loop import slack_app

    slack_app.start()


if __name__ == "__main__":
    main()