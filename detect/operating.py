"""Operating points for the false-alarm slider (T12c): SPRT alpha -> measured Pfa / Pd.

eval (make eval) runs detect() at each slider alpha on windows built like the report's (own seed) and writes
eval/operating_points.json; the worker computes findings at each of these alphas and the dashboard
lets the user pick one. CFAR k stays fixed (detect/config.py): on the eval background k does not
move Pfa (0 for every k on the grid), while alpha moves Pd of small swarms and the decision time.

Measured Pfa is a share of background windows with an alarm; with 0 alarms in N windows it is
reported together with the 95% upper bound 3/N (rule of three), never as an exact zero.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from pydantic import BaseModel, Field

from detect.config import DEFAULT

POINTS_PATH = Path(__file__).resolve().parent.parent / "eval" / "operating_points.json"
SLIDER_ALPHAS = (0.01, 0.02, 0.05)  # slider stops; 0.02 is the design alpha (main findings table)
DEFAULT_ALPHA = DEFAULT.alpha  # the design alpha: what detect() uses unless told otherwise


class OperatingPoint(BaseModel):
    alpha: float = Field(gt=0, lt=1)  # SPRT design false-alarm probability (detect(alpha=...))
    pfa: float = Field(ge=0, le=1)  # measured: share of background windows with a coordinated finding
    pfa_upper95: float = Field(ge=0, le=1)  # one-sided 95% upper bound on pfa (3/N when no alarm)
    pd: float = Field(ge=0, le=1)  # measured on the ROC swarm size (eval ROC_SWARM_ACCOUNTS)
    pd_small: float = Field(ge=0, le=1)  # measured on the smallest swarm (3 accounts)
    posts_to_decision: float | None = None  # mean posts from the group's first post to "coordinated"
    n_background: int = Field(ge=1)
    # "real" windows only: non-overlapping 6 h pieces of the live timeline, the independent experiments
    n_independent: int = Field(default=0, ge=0)
    pfa_independent: float | None = Field(default=None, ge=0, le=1)
    pfa_independent_upper95: float | None = Field(default=None, ge=0, le=1)


class OperatingPoints(BaseModel):
    generated_at: datetime
    embedder: str
    cfar_k: float
    default_alpha: float = DEFAULT_ALPHA
    points: list[OperatingPoint]


def pfa_upper95(alarms: int, n: int) -> float:
    """One-sided 95% Clopper-Pearson upper bound on a binomial rate (0 alarms: 1 - 0.05^(1/n) ~ 3/n)."""
    if n <= 0 or not 0 <= alarms <= n:
        raise ValueError("need n > 0 and 0 <= alarms <= n")
    if alarms == n:
        return 1.0
    from scipy.stats import beta

    return float(beta.ppf(0.95, alarms + 1, n - alarms))


def load_points(path: Path = POINTS_PATH) -> OperatingPoints | None:
    """eval/operating_points.json, or None if it is missing or invalid."""
    try:
        return OperatingPoints.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def alpha_for_pfa(points: list[OperatingPoint], pfa: float) -> float:
    """Largest slider alpha whose design alpha and measured Pfa both stay <= pfa.

    Larger alpha = earlier decisions and smaller swarms caught, so the largest admissible one is the
    Neyman-Pearson choice. If none qualifies, the most conservative (smallest) alpha.
    """
    if not points:
        raise ValueError("no operating points")
    ok = [p.alpha for p in points if p.alpha <= pfa and p.pfa <= pfa]
    return max(ok) if ok else min(p.alpha for p in points)


def write_points(points: OperatingPoints, path: Path = POINTS_PATH) -> None:
    path.write_text(json.dumps(points.model_dump(mode="json"), indent=1) + "\n", encoding="utf-8")
