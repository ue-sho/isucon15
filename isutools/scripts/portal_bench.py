"""Start one portal benchmark, wait for that job, and print its result."""

import io
import json
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request


# Field numbers and statuses match the current portal's bundled Protobuf schemas.
# See docs/benchmark.md for the inspected JavaScript and public schemas.
STATUSES = {0: "PENDING", 1: "RUNNING", 2: "ERRORED", 3: "CANCELLED", 4: "FINISHED"}


def encode_varint(value):
    data = bytearray()
    while value > 127:
        data.append((value & 127) | 128)
        value >>= 7
    data.append(value)
    return bytes(data)


def read_varint(stream):
    value = 0
    for shift in range(0, 70, 7):
        byte = stream.read(1)
        if not byte:
            break
        value |= (byte[0] & 127) << shift
        if byte[0] < 128:
            return value
    raise RuntimeError("Protobufの整数を読み取れません。")


def fields(data):
    """Read scalar/submessage fields; skip unused fixed-width fields."""
    stream = io.BytesIO(data)
    values = {}
    while stream.tell() < len(data):
        tag = read_varint(stream)
        number, wire = tag >> 3, tag & 7
        if number == 0:
            raise RuntimeError("Protobufのフィールド番号が不正です。")
        if wire == 0:
            values[number] = read_varint(stream)
            continue
        if wire == 2:
            size = read_varint(stream)
        elif wire in (1, 5):
            size = 8 if wire == 1 else 4
        else:
            raise RuntimeError("未対応のProtobuf形式です。")
        value = stream.read(size)
        if len(value) != size:
            raise RuntimeError("Protobuf応答が途中で切れています。")
        if wire == 2:
            values[number] = value
    return values


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def main():
    target = int(os.environ["PORTAL_TARGET_ID"])
    if not 0 < target < 2**63:
        raise RuntimeError("PORTAL_TARGET_IDには対象サーバーの正の整数IDを指定してください。")
    base = (os.environ.get("PORTAL_URL") or "https://portal.isucon.net").rstrip("/")
    headers = {
        "Accept": "application/vnd.google.protobuf",
        "Content-Type": "application/vnd.google.protobuf",
        "Cookie": os.environ["PORTAL_COOKIE"],
        "X-Csrf-Token": os.environ["PORTAL_CSRF_TOKEN"],
    }
    opener = urllib.request.build_opener(NoRedirect)

    def request(suffix, data=None):
        req = urllib.request.Request(
            base + "/api/contestant/benchmark_jobs" + suffix, data=data, headers=headers
        )
        with opener.open(req, timeout=30) as response:
            if "protobuf" not in response.headers.get("Content-Type", ""):
                raise RuntimeError("Protobuf以外の応答です。ログイン状態とAPI仕様を確認してください。")
            return fields(fields(response.read())[1])  # Response.job = field 1

    # Write before POST: a lost response can still mean a job was accepted.
    state = Path(os.environ["ISUTOOLS_BENCH_STATE"])
    state.write_text(json.dumps({"status": "submission-unknown"}) + "\n", encoding="utf-8")
    job = request("", b"\x08" + encode_varint(target))  # Request.target_id = field 1
    job_id = job[1]
    state.write_text(json.dumps({"job_id": job_id, "status": "active"}) + "\n", encoding="utf-8")
    print(f"job_id={job_id}", flush=True)
    deadline = time.monotonic() + 600
    while job.get(4, 0) in (0, 1):  # Job.status = field 4; PENDING / RUNNING
        if time.monotonic() >= deadline:
            raise RuntimeError("完了待ちが10分を超えました。ポータル上でジョブの状態を確認してください。")
        time.sleep(3)
        job = request(f"/{job_id}")

    status = job.get(4, 0)
    if status not in (2, 3, 4):
        raise RuntimeError("ジョブの終了を確認できません。ポータル上で状態を確認してください。")
    state.unlink()  # Only a confirmed terminal job permits the deploy lock to be released.
    if status == 4 and 18 not in job:
        raise RuntimeError("FINISHEDの応答にベンチ結果がありません。API仕様を確認してください。")
    result = fields(job.get(18, b""))  # Job.result = field 18
    execution = fields(result.get(5, b""))  # Result.execution = field 5
    for number in (1, 2, 3):  # Execution.reason / stdout / stderr
        text = execution.get(number, b"").decode("utf-8", errors="replace").rstrip()
        if text:
            print(text, flush=True)
    passed = bool(result.get(2, 0)) if 18 in job else None
    score = job.get(9, 0) if status == 4 else None
    if score is not None and score >= 2**63:
        score -= 2**64  # Job.score is int64
    print(json.dumps({
        "job_id": job_id, "status": STATUSES.get(status, str(status)),
        "passed": passed, "score": score,
    }, ensure_ascii=False), flush=True)
    return 0 if status == 4 and result.get(1, 0) and passed else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except urllib.error.HTTPError as error:
        print(f"ポータルAPI: HTTP {error.code}。認証と競技開始状態を確認してください。", file=sys.stderr)
    except RuntimeError as error:
        print(error, file=sys.stderr)
    except (OSError, KeyError, ValueError, TypeError) as error:
        # Exception messages can contain authentication header values.
        print(f"ポータルAPIに失敗しました ({type(error).__name__})。設定と応答を確認してください。", file=sys.stderr)
    sys.exit(1)
