"""Run the code cells of a notebook under CPython, in order, the way the browser runtime does.

Cells may use top-level ``await``. The real ``lab`` package (python/lab) is used, with
fake_lab_js standing in for the browser.
"""

import ast
import asyncio
import contextlib
import inspect
import io
import json
import sys
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
NOTEBOOKS = REPO / "notebooks"


def install_lab():
    """Make ``import lab`` find python/lab, connected to the fake browser side. Returns the fake."""
    import fake_lab_js

    sys.modules["_lab_js"] = fake_lab_js
    if str(REPO / "python") not in sys.path:
        sys.path.insert(0, str(REPO / "python"))
    for name in [n for n in sys.modules if n == "lab" or n.startswith("lab.")]:
        del sys.modules[name]
    fake_lab_js.reset()
    return fake_lab_js


def load(name):
    return json.loads((NOTEBOOKS / name).read_text(encoding="utf-8"))


class CellError(Exception):
    def __init__(self, cell_id, index, original):
        super().__init__(f"cell {index} ({cell_id}) raised {type(original).__name__}: {original}")
        self.cell_id = cell_id
        self.original = original


def run(notebook, replace=None, stop_on_error=True, quiet=True):
    """Execute the code cells. ``replace`` maps cell ids to other source (the reference solutions).

    Returns (namespace, results) where results maps a cell id to None or the exception it raised.
    What the cells print is kept in ``namespace["__printed__"]`` (and not shown) unless quiet is False.
    """
    replace = replace or {}
    namespace = types.ModuleType("__main__").__dict__
    loop = asyncio.new_event_loop()
    results = {}
    printed = io.StringIO()
    namespace["__printed__"] = printed
    with contextlib.ExitStack() as stack:
        if quiet:
            stack.enter_context(contextlib.redirect_stdout(printed))
        _run_cells(notebook, replace, stop_on_error, namespace, loop, results)
    return namespace, results


def _run_cells(notebook, replace, stop_on_error, namespace, loop, results):
    try:
        for index, cell in enumerate(notebook["cells"]):
            if cell["cell_type"] != "code":
                continue
            source = replace.get(cell["id"], "".join(cell["source"]))
            try:
                code = compile(source, f"<cell {cell['id']}>", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
                value = eval(code, namespace)
                if inspect.iscoroutine(value):
                    loop.run_until_complete(value)
                results[cell["id"]] = None
            except Exception as err:  # noqa: BLE001
                results[cell["id"]] = err
                if stop_on_error:
                    raise CellError(cell["id"], index, err) from err
    finally:
        loop.close()


def check_cells(notebook):
    return [cell["id"] for cell in notebook["cells"] if cell["cell_type"] == "code" and "check" in cell["metadata"].get("tags", [])]
