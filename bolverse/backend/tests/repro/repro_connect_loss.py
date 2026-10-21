"""Reproduces Connect message loss against the server as it is, simulating the clients' exact logic
(apps/*/src/lib/chats.tsx: fetch inbox + chat list, merge with mergeInbox rules, then ack every id)."""
import os, sys, tempfile, logging, json
ROOT = sys.argv[1]
sys.path.insert(0, ROOT)
D = tempfile.mkdtemp()
os.environ.update(BOLVERSE_DATABASE_URL=f"sqlite:///{D}/t.db", BOLVERSE_SECRET_KEY="s", BOLVERSE_DEV_MODE="true",
                  BOLVERSE_OTP_RESEND_SECONDS="0", BOLVERSE_AI_DEMO="true", BOLVERSE_DASHBOARD_DIR=D + "/none")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s", stream=sys.stdout)
logging.getLogger("httpx").setLevel(logging.INFO)
from fastapi.testclient import TestClient
from app import main

def login(c, phone, dev):
    h = {"X-Device-Id": dev}
    c.post("/auth/otp", json={"phone": phone}, headers=h)
    t = c.post("/auth/verify", json={"phone": phone, "code": "123456"}, headers=h).json()["token"]
    return {**h, "Authorization": f"Bearer {t}"}

class Client:
    """Same logic as ChatsProvider.refresh() + mergeInbox()."""
    def __init__(s, c, h, name): s.c, s.h, s.name, s.chats = c, h, name, {}
    def poll(s):
        inbox = s.c.get("/connect/inbox", headers=s.h).json()["messages"]
        live = s.c.get("/connect", headers=s.h).json()
        for ch in live: s.chats.setdefault(ch["id"], [])
        kept = []
        for m in inbox:
            if m["connection_id"] not in s.chats:
                if not m.get("peer"):
                    print(f"[client {s.name}] SKIP message {m['id']} for unknown chat {m['connection_id'][:8]} (still acked below)")
                    continue
                s.chats[m["connection_id"]] = []
            s.chats[m["connection_id"]].append(m); kept.append(m["id"])
        if inbox:
            s.c.post("/connect/ack", json={"ids": [m["id"] for m in inbox]}, headers=s.h)
        print(f"[client {s.name}] inbox={[m['id'] for m in inbox]} saved={kept}")

with TestClient(main.app) as c:
    print("\n=== Scenario 1: recipient signed in on two devices (phone + web) ===")
    asha_phone = login(c, "+919000000001", "asha-phone"); asha_web = login(c, "+919000000001", "asha-web")
    rahul = login(c, "+919000000002", "rahul-phone")
    cid = c.get("/connect", headers=rahul).json()[0]["id"]
    phone, web = Client(c, asha_phone, "asha-phone"), Client(c, asha_web, "asha-web")
    phone.poll(); web.poll()
    r = c.post(f"/connect/{cid}/messages", data={"text": "Are you coming?"}, headers=rahul)
    print("[server] send ->", r.status_code, "id", r.json().get("id"))
    phone.poll(); web.poll()
    got_web = any(m.get("original") == "Are you coming?" for m in web.chats.get(cid, []))
    print("RESULT scenario 1: web received =", got_web, "(expected True)")

    print("\n=== Scenario 2: message for a chat this device hasn't listed yet ===")
    # Priya joins Vikram's QR; Vikram's device is mid-poll: its chat list was fetched before the join,
    # the inbox after Priya's first message.
    vikram = login(c, "+919000000004", "vikram-phone"); priya = login(c, "+919000000003", "priya-phone")
    v = Client(c, vikram, "vikram-phone")
    live_before = c.get("/connect", headers=vikram).json()
    inv = c.post("/connect/invite", headers=vikram).json()
    cid2 = c.post("/connect/join", json={"token": inv["token"]}, headers=priya).json()["connection"]["id"]
    # Vikram's device already saw the 'joined' event in an earlier poll and acked it, then the user
    # cleared the chat / reinstalled, or the 'joined' event was dropped by the disconnect clean-up.
    c.post("/connect/ack", json={"ids": [m["id"] for m in c.get("/connect/inbox", headers=vikram).json()["messages"]]}, headers=vikram)
    r = c.post(f"/connect/{cid2}/messages", data={"text": "Hello from Priya"}, headers=priya)
    print("[server] send ->", r.status_code, "id", r.json().get("id"))
    # race: list fetched before join (stale), inbox fetched now
    inbox = c.get("/connect/inbox", headers=vikram).json()["messages"]
    known = {ch["id"] for ch in live_before}
    for m in inbox:
        if m["connection_id"] not in known and not m.get("peer"):
            print(f"[client vikram-phone] SKIP message {m['id']} for unknown chat (acked anyway)")
    c.post("/connect/ack", json={"ids": [m["id"] for m in inbox]}, headers=vikram)
    left = c.get("/connect/inbox", headers=vikram).json()["messages"]
    print("RESULT scenario 2: message still on server after ack =", bool(left), "-> lost (expected kept until saved)")

    print("\n=== Scenario 3: sender retries after a timeout ===")
    r1 = c.post(f"/connect/{cid}/messages", data={"text": "Call me"}, headers=rahul)
    r2 = c.post(f"/connect/{cid}/messages", data={"text": "Call me"}, headers=rahul)  # user tapped send again
    msgs = [m for m in c.get("/connect/inbox", headers=asha_phone).json()["messages"] if m["original"] == "Call me"]
    print("RESULT scenario 3: copies delivered =", len(msgs), "(expected 1)")
