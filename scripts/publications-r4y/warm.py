"""Fill the page cache for every RINA PDF before the loaders run."""
from pathlib import Path

import pdf_pages

if __name__ == "__main__":
    files = sorted((Path.home() / "Downloads" / "RINA").rglob("*.pdf"))
    print(f"всего {len(files)} PDF", flush=True)
    pdf_pages.warm(files)
    print("КЭШ ГОТОВ", flush=True)
