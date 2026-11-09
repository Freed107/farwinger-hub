# AUTOMATION-CARD
# what: The estate side of the PERDIMI creator portal. (1) Renders: takes Blessing's queued render jobs, runs the FREE
#   Higgsfield cost preflight and reports it (the portal decides: run now, or wait for Fred), then renders the
#   approved ones and uploads result + small preview. (2) Tasks: pulls her team requests into the ledger, same
#   contract as aichabelle_portal_pull.py. (3) Knowledge: optionally pushes the PERDIMI canon/style book to the portal.
# mode: ACTS (spends Higgsfield credits on APPROVED jobs only; adds ledger rows)
# surface: api, higgsfield, ledger
# never: renders a job the portal has not approved; renders final quality from anything but the job as given;
#   sends anything outside the PERDIMI/VENENVM/LUCCIVO knowledge files named in KNOWLEDGE_FILES
r"""perdimi_portal_runner.py

  python perdimi_portal_runner.py renders           # one pass: estimate new jobs, render approved ones
  python perdimi_portal_runner.py renders --dry-run # show what it would do, spend nothing
  python perdimi_portal_runner.py tasks             # pull team requests into the ledger
  python perdimi_portal_runner.py knowledge         # push the knowledge files to the portal
  python perdimi_portal_runner.py all               # renders + tasks (schedule this every 2-5 minutes)

Config: an env file (default H:\Global-Vault\_OPERATIONS\_secrets\perdimi-portal.env, override with PERDIMI_PORTAL_ENV):
  PORTAL=https://perdimi-creator-portal.<account>.workers.dev
  RUNNER_TOKEN=...                       (same value as the Worker secret)
  HF_COST_CMD=...                        command template printing the credit cost as JSON {"credits": N}
  HF_RENDER_CMD=...                      command template that renders and prints JSON {"file": "<path>", "credits": N}
  KNOWLEDGE_FILES=path1;path2            optional, files pushed by `knowledge` (key = file name)
Templates get the job as a JSON file path in {job}; e.g.  HF_COST_CMD=python H:\...\hf_job.py cost --job {job}
The Higgsfield calls are deliberately NOT hard-coded here: plug in the estate's existing, proven Higgsfield tooling
(the playbook's free preflight + draft/final flow, --authorised-by / --max-usd gate) through these two templates.

Exit: 0 ok, 1 portal unreachable / auth refused, 2 a job or ledger write failed.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shlex
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

ENV_FILE = Path(os.environ.get("PERDIMI_PORTAL_ENV", r"H:\Global-Vault\_OPERATIONS\_secrets\perdimi-portal.env"))
OPS = Path(r"H:\Global-Vault\_OPERATIONS")
LEDGER_PY = OPS / "scripts" / "ledger.py"
HEARTBEAT = OPS / "logs" / "perdimi-portal-runner.json"
DUE_DAYS = {"urgent": 0, "soon": 2, "normal": 5}
TEAM_PERSONA = {"seo": "seona", "marketing": "tim", "creative_director": "rhoden", "film_crew": "nick", "fred": "fred"}


def cfg() -> dict:
    out = {}
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    for need in ("PORTAL", "RUNNER_TOKEN"):
        if not out.get(need):
            raise SystemExit(f"{need} missing from {ENV_FILE}")
    return out


class Portal:
    def __init__(self, c: dict):
        self.base = c["PORTAL"].rstrip("/")
        self.tok = c["RUNNER_TOKEN"]

    def call(self, method: str, path: str, body=None, raw: bytes | None = None, ctype: str | None = None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self.base + path, method=method, data=data, headers={
            "authorization": f"Bearer {self.tok}",
            "content-type": ctype or "application/json",
            "user-agent": "perdimi-portal-runner/1",
        })
        with urllib.request.urlopen(req, timeout=120) as r:
            b = r.read()
            return json.loads(b.decode()) if r.headers.get("content-type", "").startswith("application/json") else b


def run_template(template: str, job: dict) -> dict:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        json.dump(job, f)
        path = f.name
    try:
        cmd = [part.replace("{job}", path) for part in shlex.split(template, posix=(os.name != "nt"))]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
        if r.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout)[-400:])
        return json.loads(r.stdout.strip().splitlines()[-1])
    finally:
        os.unlink(path)


def make_preview(src: Path, kind: str) -> bytes | None:
    """Small JPEG for the phone: 640px still, or the first frame of a video (needs Pillow / ffmpeg)."""
    try:
        out = Path(tempfile.mkstemp(suffix=".jpg")[1])
        if kind == "video":
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", "0.3", "-i", str(src), "-frames:v", "1",
                            "-vf", "scale='min(640,iw)':-2", "-q:v", "5", str(out)], check=True, timeout=120)
        else:
            from PIL import Image
            im = Image.open(src).convert("RGB")
            im.thumbnail((640, 640))
            im.save(out, "JPEG", quality=72)
        data = out.read_bytes()
        out.unlink()
        return data
    except Exception as e:  # a missing preview is not fatal: the phone falls back to the full file
        print("  preview failed:", e)
        return None


def do_renders(p: Portal, c: dict, dry: bool) -> list:
    failed = []
    jobs = p.call("GET", "/api/runner/renders")["renders"]
    for j in jobs:
        jid = j["id"]
        # reference media (her uploads / the kept draft) are downloaded so the render tool can use them
        refs = []
        for mid in list(j.get("ref_media") or []) + ([j["parent_media_id"]] if j.get("parent_media_id") else []):
            data = p.call("GET", f"/api/runner/media/{mid}")
            fp = Path(tempfile.gettempdir()) / f"perdimi-ref-{mid}"
            fp.write_bytes(data)
            refs.append(str(fp))
        job = {**j, "ref_files": refs, "authorised_by": "perdimi-portal (approved in portal)"}

        if j["status"] == "estimating":
            if dry:
                print("WOULD ESTIMATE", jid, j["kind"], j["quality"]); continue
            try:
                est = run_template(c["HF_COST_CMD"], job)
                r = p.call("POST", f"/api/runner/renders/{jid}/estimate", {"credits": float(est["credits"])})
                print("ESTIMATED", jid, est["credits"], "->", r.get("status"), r.get("reason") or "")
            except Exception as e:
                failed.append({"id": jid, "step": "estimate", "error": str(e)[:300]})
            continue

        if j["status"] == "approved":
            if dry:
                print("WOULD RENDER", jid, j["kind"], j["quality"], "~", j.get("est_credits"), "cr"); continue
            try:
                p.call("POST", f"/api/runner/renders/{jid}/start")  # 409 if she cancelled meanwhile -> raises, skipped
            except Exception as e:
                print("SKIP", jid, e); continue
            try:
                res = run_template(c["HF_RENDER_CMD"], job)
                f = Path(res["file"])
                ctype = "video/mp4" if j["kind"] == "video" else ("image/png" if f.suffix.lower() == ".png" else "image/jpeg")
                p.call("PUT", f"/api/runner/renders/{jid}/result/full", raw=f.read_bytes(), ctype=ctype)
                prev = make_preview(f, j["kind"])
                if prev:
                    p.call("PUT", f"/api/runner/renders/{jid}/result/preview", raw=prev, ctype="image/jpeg")
                p.call("POST", f"/api/runner/renders/{jid}/done", {"actual_credits": res.get("credits")})
                print("DONE", jid, f.name)
            except Exception as e:
                p.call("POST", f"/api/runner/renders/{jid}/fail", {"error": str(e)[:300]})
                failed.append({"id": jid, "step": "render", "error": str(e)[:300]})
    return failed


def do_tasks(p: Portal, dry: bool) -> list:
    failed = []
    for t in p.call("GET", "/api/pull/tasks")["tasks"]:
        due = (dt.date.today() + dt.timedelta(days=DUE_DAYS.get(t.get("urgency"), 5))).isoformat()
        title = f"PERDIMI creator ({t['team']}): {t['title']}"[:240]
        detail = (f"From {t.get('person_name')} via the PERDIMI creator portal, {t['created_at'][:16]} "
                  f"(portal task {t['id']}, urgency {t.get('urgency')}).\n\n{t.get('detail') or ''}\n\n"
                  "Reply to her from /admin (Team tasks) - she sees it in the portal. Scope: PERDIMI/VENENVM/LUCCIVO only.")
        if dry:
            print("WOULD FILE", due, title); continue
        r = subprocess.run([sys.executable, str(LEDGER_PY), "add-task", "--venture", "perdimi",
                            "--persona", TEAM_PERSONA.get(t["team"], "fred"), "--one-off", "--due", due, "--dup-ok",
                            "--source", f"perdimi creator portal task {t['id']}",
                            "--action", title, "--detail", detail], capture_output=True, text=True, timeout=120)
        try:
            lid = json.loads(r.stdout.strip().splitlines()[-1]).get("added")
        except Exception:
            lid = None
        if not lid:
            failed.append({"id": t["id"], "out": (r.stdout + r.stderr)[-300:]}); continue
        p.call("POST", "/api/pull/tasks", {"id": t["id"], "ledger_id": lid})
        print("FILED", t["id"], "->", lid, title)
    return failed


def do_knowledge(p: Portal, c: dict, dry: bool) -> None:
    for raw in filter(None, (c.get("KNOWLEDGE_FILES") or "").split(";")):
        f = Path(raw.strip())
        key = f.stem[:80]
        if dry:
            print("WOULD PUSH", key, f.stat().st_size, "bytes"); continue
        p.call("PUT", f"/api/runner/knowledge/{urllib.parse.quote(key)}", raw=f.read_bytes(), ctype="text/plain; charset=utf-8")
        print("PUSHED", key)


def beat(status: str, **kw) -> None:
    try:
        HEARTBEAT.parent.mkdir(parents=True, exist_ok=True)
        HEARTBEAT.write_text(json.dumps({"ts": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                                         "status": status, **kw}, indent=2), encoding="utf-8")
    except OSError:
        pass


def main() -> int:
    import urllib.parse  # noqa: F401  (used in do_knowledge)
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["renders", "tasks", "knowledge", "all"])
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    c = cfg()
    p = Portal(c)
    try:
        p.call("GET", "/api/runner/renders")
    except Exception as e:  # unreachable or refused: loud, never read as "nothing to do"
        beat("fail", error=str(e)[:300])
        print("FAIL portal:", e)
        return 1
    failed = []
    if a.what in ("renders", "all"):
        failed += do_renders(p, c, a.dry_run)
    if a.what in ("tasks", "all"):
        failed += do_tasks(p, a.dry_run)
    if a.what == "knowledge":
        do_knowledge(p, c, a.dry_run)
    beat("fail" if failed else "ok", failed=failed)
    for f in failed:
        print("FAILED", f)
    return 2 if failed else 0


if __name__ == "__main__":
    import urllib.parse
    sys.exit(main())
