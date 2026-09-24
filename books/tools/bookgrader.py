"""Helpers used by chapter tests to load the code under grade.

Tests never import learner code directly. They call ``load_solution`` with a
module name declared in the node's front matter; the runner points
``BOOK_SOLUTION_DIR`` at either the learner workspace (``run``) or the
node's reference solution (``verify``), so the same tests grade both.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path


class GraderSetupError(RuntimeError):
    pass


def solution_dir() -> Path:
    root = os.environ.get("BOOK_SOLUTION_DIR")
    if not root:
        raise GraderSetupError(
            "BOOK_SOLUTION_DIR is not set. Run tests through "
            "`python3 books/tools/grade.py <node>` instead of directly."
        )
    path = Path(root)
    if not path.is_dir():
        raise GraderSetupError(f"BOOK_SOLUTION_DIR does not exist: {path}")
    return path


def load_solution(module_name: str):
    """Import ``<BOOK_SOLUTION_DIR>/<module_name>.py`` and return the module."""
    path = solution_dir() / f"{module_name}.py"
    if not path.is_file():
        raise GraderSetupError(
            f"Expected solution file is missing: {path}\n"
            f"Did you run `python3 books/tools/grade.py start <node>`?"
        )
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise GraderSetupError(f"Could not load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module
