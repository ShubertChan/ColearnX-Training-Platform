"""Rehearse a logical DB restore and a frontend/API rollback, using synthetic data only."""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, build_opener

DB = "colearnx_drill"
OWNER = "drill_owner"
HTTP = build_opener(ProxyHandler({}))
SAFE_ENV = {k: v for k, v in os.environ.items() if k.upper() in {
    "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TMP", "TEMP", "TMPDIR",
    "HOME", "HOMEPATH", "HOMEDRIVE", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG"
}}


def command(args, env=None, data=None, cwd=None, timeout=120):
    proc = subprocess.run([str(x) for x in args], input=data, cwd=cwd, env=env or SAFE_ENV,
                          capture_output=True, encoding="utf-8", errors="replace", timeout=timeout)
    if proc.returncode:
        # DB URLs and generated role passwords are intentionally never logged.
        detail = re.sub(r"postgres(?:ql)?://\S+|(?i:PASSWORD)\s+'[^']*'", "[redacted]",
                        proc.stderr.strip()[-600:])
        raise RuntimeError(f"{Path(args[0]).name} failed ({proc.returncode}): {detail}")
    return proc.stdout.strip()


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def spare_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Cluster:
    def __init__(self, tools, path, owner_password, app_password):
        self.tools, self.path = tools, path
        self.port = spare_port()
        self.owner_password, self.app_password = owner_password, app_password
        self.pg = {**SAFE_ENV, "PGHOST": "127.0.0.1", "PGPORT": str(self.port),
                   "PGDATABASE": DB, "PGUSER": OWNER, "PGPASSWORD": owner_password,
                   "PGCONNECT_TIMEOUT": "5", "PGCLIENTENCODING": "UTF8", "PGSSLMODE": "disable"}

    def bin(self, name):
        return self.tools / (name + (".exe" if os.name == "nt" else ""))

    def sql(self, query, database=DB):
        return command([self.bin("psql"), "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-d", database],
                       env=self.pg, data=query)

    def dsn(self, role):
        password = self.owner_password if role == OWNER else self.app_password
        return f"postgresql://{role}:{password}@127.0.0.1:{self.port}/{DB}"

    def control(self, *arguments):
        # On Windows the background postmaster can inherit a capture pipe and
        # keep it open after pg_ctl exits. Server diagnostics go to postgres.log.
        subprocess.run([self.bin("pg_ctl"), "-D", self.path / "data", *arguments],
                       env=SAFE_ENV, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, check=True, timeout=65)

    @contextlib.contextmanager
    def running(self):
        self.path.mkdir()
        data = self.path / "data"
        with tempfile.NamedTemporaryFile(dir=self.path, mode="w", delete=False) as pw:
            pw.write(self.owner_password + "\n")
        try:
            command([self.bin("initdb"), "-D", data, "-U", OWNER, "--pwfile", pw.name,
                     "--auth=scram-sha-256", "--locale=C", "--encoding=UTF8"])
        finally:
            Path(pw.name).unlink(missing_ok=True)
        # TCP only; a second cluster uses a different port and its own data directory.
        options = f"-p {self.port} -c listen_addresses=127.0.0.1"
        if os.name != "nt":
            options += " -c unix_socket_directories=''"
        try:
            log = self.path / "postgres.log"
            try:
                self.control("-l", log, "-o", options, "-w", "-t", "45", "start")
            except (subprocess.SubprocessError, OSError) as error:
                # No SQL or application credentials have been used at startup.
                tail = log.read_text(errors="replace")[-750:] if log.exists() else "no startup log"
                raise RuntimeError(f"{error}\n{tail}") from error
            self.sql(f"""CREATE ROLE colearnx_app LOGIN PASSWORD '{self.app_password}'
                         NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
                         CREATE ROLE colearnx_migrator NOLOGIN;
                         CREATE ROLE colearnx_readonly NOLOGIN;
                         CREATE ROLE colearnx_video_worker NOLOGIN;
                         CREATE DATABASE {DB};""", database="postgres")
            major = int(self.sql("SHOW server_version_num")) // 10000
            check(major == 16, "The exercise must use PostgreSQL 16.")
            yield self
        finally:
            if (data / "postmaster.pid").exists():
                self.control("-m", "fast", "-w", "stop")


def snapshot(cluster):
    # Compare ledger timestamps too. Counts and a real FK join detect accidental
    # restores into an empty or wrong DB. Capture grants independently of row data.
    return json.loads(cluster.sql("""
        SELECT json_build_object(
          'ledger',(SELECT json_agg(json_build_array(filename, checksum, applied_at) ORDER BY filename) FROM schema_migrations),
          'tables',(SELECT count(*) FROM pg_tables WHERE schemaname='public'),
          'indexes',(SELECT count(*) FROM pg_indexes WHERE schemaname='public'),
          'constraints',(SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace),
          'definitions',(SELECT json_agg(definition ORDER BY definition) FROM (
              SELECT 'C '||conrelid::regclass||' '||conname||' '||pg_get_constraintdef(oid) AS definition
                FROM pg_constraint WHERE connamespace='public'::regnamespace
              UNION ALL SELECT 'I '||indexdef FROM pg_indexes WHERE schemaname='public'
              UNION ALL SELECT 'T '||table_name||' '||column_name||' '||udt_name||' '||is_nullable||' '||
                coalesce(column_default,'') FROM information_schema.columns WHERE table_schema='public'
          ) objects),
          'accounts',(SELECT json_agg(json_build_array(u.email,r.role_code) ORDER BY u.email,r.role_code)
                      FROM users u JOIN user_roles ur USING(user_id) JOIN roles r USING(role_id)),
          'package',(SELECT points_amount FROM point_topup_packages WHERE package_code='recovery-fixture'),
          'app_object_key',has_column_privilege('colearnx_app','storage_assets','object_key','UPDATE'),
          'app_ledger_read',has_table_privilege('colearnx_app','schema_migrations','SELECT')
        )"""))


def fixture(cluster):
    cluster.sql("""
        INSERT INTO users(user_id,full_name,email,password_hash)
        VALUES('99999999-0000-4000-8000-000000000001','Recovery Fixture','drill@example.test','no-login-fixture');
        INSERT INTO roles(role_id,role_code,role_name,description)
        VALUES('99999999-0000-4000-8000-000000000002','member','Member','Synthetic recovery role');
        INSERT INTO user_roles(user_id,role_id)
        VALUES('99999999-0000-4000-8000-000000000001','99999999-0000-4000-8000-000000000002');
        INSERT INTO point_topup_packages(package_code,display_name,currency_code,fiat_amount,points_amount,is_active)
        VALUES('recovery-fixture','Recovery fixture','sgd',100,25,true);
    """)


def fetch(base, path):
    with HTTP.open(base + path, timeout=4) as response:
        return response.read()


def exercise_pair(args, root, cluster, commit, port, work, expected_points):
    origin = f"http://127.0.0.1:{port}"
    env = {**SAFE_ENV, "NODE_ENV": "development", "PORT": str(port), "APP_ORIGIN": origin,
           "API_ORIGIN": origin, "DATABASE_URL": cluster.dsn("colearnx_app"), "DATABASE_SSL": "false",
           "EMAIL_PROVIDER": "disabled", "OBJECT_STORAGE_PROVIDER": "disabled", "ENABLE_HOSTED_VIDEO": "false",
           "ACCESS_TOKEN_SECRET": secrets.token_hex(32), "REFRESH_TOKEN_SECRET": secrets.token_hex(32),
           "CSRF_SECRET": secrets.token_hex(32), "LOG_LEVEL": "error"}
    root = root / "colearnx-v1.0"
    adapter = Path(__file__).with_name("drill-web.mjs")
    start = time.monotonic()
    with (work / f"{commit}-app.log").open("ab") as log:
        app = subprocess.Popen([args.node, adapter, root], env=env, cwd=work, stdout=log, stderr=log)
        try:
            deadline = start + 30
            while time.monotonic() < deadline:
                check(app.poll() is None, "Exercise API exited before becoming ready.")
                try:
                    if json.loads(fetch(origin, "/health/ready"))["data"]["status"] == "ready":
                        break
                except (URLError, TimeoutError):
                    time.sleep(0.1)
            else:
                raise RuntimeError("Exercise API did not become ready.")
            ready_time = time.monotonic() - start
            index = fetch(origin, "/")
            check(index == (root / "dist/index.html").read_bytes(), "Frontend index differs from this release.")
            script = re.search(rb'<script\b[^>]*\bsrc="([^"]+)"', index)
            check(script is not None, "Frontend entry script missing.")
            entry = script.group(1).decode().removeprefix("./").lstrip("/")
            check(re.fullmatch(r"assets/[\w.-]+\.js", entry), "Unexpected entry asset.")
            bundle = fetch(origin, "/" + entry)
            check(digest(bundle) == digest((root / "dist" / entry).read_bytes()), "Frontend bundle mismatch.")
            packages = json.loads(fetch(origin, "/api/v1/wallet/top-up-packages"))["data"]
            check(any(p["code"] == "recovery-fixture" and p["points"] == expected_points for p in packages),
                  "Runtime role could not read restored application data.")
            try:
                fetch(origin, "/api/v1/me")
                raise RuntimeError("Anonymous protected endpoint unexpectedly succeeded.")
            except HTTPError as error:
                check(error.code == 401, "Unexpected anonymous response.")
            return {"commit": commit, "frontendSha256": digest(bundle), "readySeconds": round(ready_time, 3),
                    "restoredPackagePoints": expected_points, "anonymousMe": 401}
        finally:
            app.terminate()
            try:
                app.wait(timeout=8)
            except subprocess.TimeoutExpired:
                app.kill()
                app.wait()


def drill(args):
    check(not args.evidence.exists(), "Choose a new evidence file; reports are not overwritten.")
    current = command(["git", "-C", args.candidate, "rev-parse", "HEAD"])
    previous = command(["git", "-C", args.previous, "rev-parse", "HEAD"])
    check(current != previous, "Use two distinct releases.")
    command(["git", "-C", args.candidate, "merge-base", "--is-ancestor", previous, current])
    for root in (args.candidate, args.previous):
        inputs = ["src", "public", "db", "build", "package.json", "package-lock.json", "vite.config.js",
                  "index.html", ".node-version", "apps/api/src", "apps/api/package.json",
                  "apps/api/package-lock.json", "apps/api/tsconfig.json"]
        changed = command(["git", "-C", root, "status", "--porcelain", "--",
                           *["colearnx-v1.0/" + p for p in inputs]])
        check(not changed, "Build from a clean product checkout to report an exact Git commit.")
        for name in ("dist/index.html","apps/api/dist/app.js"):
            check((root / "colearnx-v1.0" / name).is_file(), f"Build the frontend and API first: {name}")
    args.work_root.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="cx-recovery-", dir=args.work_root)).resolve()
    check(work.parent == args.work_root.resolve(), "Invalid temporary workspace.")
    owner_pw, app_pw = secrets.token_hex(24), secrets.token_hex(24)
    src = Cluster(args.pg_bin, work / "source", owner_pw, app_pw)
    try:
        with src.running(), Cluster(args.pg_bin, work / "restored", owner_pw, app_pw).running() as dst:
            env = {**SAFE_ENV, "MIGRATION_DATABASE_URL": src.dsn(OWNER), "DATABASE_SSL": "false"}
            project = args.candidate / "colearnx-v1.0"
            command([args.node, project/"apps/api/dist/db/migrate.js"], cwd=work, env=env)
            fixture(src)
            expected = snapshot(src)
            ledger = expected["ledger"]
            inventory = sorted((project/"db/migrations").glob("*.sql"))
            check([(x[0],x[1]) for x in ledger] ==
                  [(p.name,digest(p.read_text(encoding="utf-8").encode())) for p in inventory],
                  "Migration filenames or checksums do not match candidate.")
            check(expected["accounts"] == [["drill@example.test","member"]] and expected["package"] == 25
                  and expected["app_object_key"] and not expected["app_ledger_read"],
                  "Seeded relationships or runtime grants do not match the intended fixture.")
            archive = work/"fixture.dump"
            command([src.bin("pg_dump"), "--format=custom", "--file", archive, "--dbname", DB], env=src.pg)
            src.sql("UPDATE point_topup_packages SET points_amount=999 WHERE package_code='recovery-fixture'")
            started = time.monotonic()
            command([dst.bin("pg_restore"), "--exit-on-error", "--single-transaction", "--dbname", DB,
                     archive], env=dst.pg)
            restored = snapshot(dst)
            check(restored == expected and snapshot(src)["package"] == 999, "Restored state differs from backup.")
            restore_time = time.monotonic() - started
            port = spare_port()
            promoted = exercise_pair(args,args.candidate,dst,current,port,work,25)
            # A post-release update must survive reverting the application binaries.
            dst.sql("UPDATE point_topup_packages SET points_amount=37 WHERE package_code='recovery-fixture'")
            started = time.monotonic()
            reverted = exercise_pair(args,args.previous,dst,previous,port,work,37)
            rollback_time = time.monotonic() - started
            final = snapshot(dst)
            check(final == {**expected, "package": 37}, "Rolling back the app changed the schema or lost data.")
            return {"scope":"isolated synthetic PostgreSQL 16 restore + actual built web/API rollback",
                    "testedAt":datetime.now(timezone.utc).isoformat(), "postgres":src.sql("SHOW server_version"),
                    "backupSha256":digest(archive.read_bytes()), "restoreAndValidateSeconds":round(restore_time,3),
                    "rollbackAndValidateSeconds":round(rollback_time,3), "migrations":len(ledger),
                    "lastMigration":ledger[-1][0], "tables":restored["tables"], "indexes":restored["indexes"],
                    "constraints":restored["constraints"], "ledgerIncludingAppliedTimesPreserved":True,
                    "schemaDefinitionsSha256":digest(json.dumps(restored["definitions"]).encode()),
                    "runtimeGrantsPreserved":True, "candidate":promoted, "rolledBack":reverted,
                    "postReleaseDataPreserved":True}
    finally:
        # Only the two clusters created by this invocation may be cleaned up.
        if (work.parent == args.work_root.resolve() and work.name.startswith("cx-recovery-")
            and not any((work/s/"data/postmaster.pid").exists() for s in ("source","restored"))):
            shutil.rmtree(work)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for opt in ("candidate","previous","pg-bin","work-root","evidence"):
        parser.add_argument("--"+opt, type=lambda p: Path(p).resolve(), required=True)
    parser.add_argument("--node", default="node")
    args = parser.parse_args()
    report = drill(args)
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    with args.evidence.open("x", encoding="utf-8") as output:
        json.dump(report, output, indent=2)
        output.write("\n")
    print(f'PASS: {report["migrations"]} migrations; restore {report["restoreAndValidateSeconds"]}s; '
          f'rollback {report["rollbackAndValidateSeconds"]}s. Evidence: {args.evidence}')
