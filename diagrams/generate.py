"""Generates the MedChain architecture and methodology diagrams as standalone SVGs.

Run:  python3 diagrams/generate.py
"""
from pathlib import Path
from xml.sax.saxutils import escape

OUT = Path(__file__).parent
SANS = "Helvetica Neue, Helvetica, Arial, sans-serif"
MONO = "Menlo, Consolas, Courier New, monospace"
INK = "#1f2937"
MUTED = "#4b5563"

PALETTE = {
    "user": ("#ecfdf5", "#059669"),
    "client": ("#eff6ff", "#2563eb"),
    "service": ("#fffbeb", "#d97706"),
    "chain": ("#f5f3ff", "#7c3aed"),
    "dev": ("#f8fafc", "#475569"),
    "wallet": ("#fff7ed", "#ea580c"),
    "patient": ("#fdf2f8", "#db2777"),
    "actor": ("#f0fdfa", "#0d9488"),
    "owner": ("#f1f5f9", "#475569"),
    "maker": ("#eff6ff", "#2563eb"),
}


class Svg:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.parts = []
        self.markers = set()

    def add(self, s):
        self.parts.append(s)

    def rect(self, x, y, w, h, fill="#fff", stroke=INK, rx=10, sw=1.5, dash=None):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>')

    def text(self, x, y, s, size=12, weight="normal", fill=INK, anchor="start", mono=False, halo=False, italic=False):
        fam = MONO if mono else SANS
        extra = ' stroke="#ffffff" stroke-width="5" paint-order="stroke" stroke-linejoin="round"' if halo else ""
        st = ' font-style="italic"' if italic else ""
        self.add(
            f'<text x="{x}" y="{y}" font-family="{fam}" font-size="{size}" font-weight="{weight}" '
            f'fill="{fill}" text-anchor="{anchor}"{st}{extra}>{escape(s)}</text>'
        )

    def lines(self, x, y, items, size=12, gap=None, **kw):
        gap = gap or size * 1.35
        for i, s in enumerate(items):
            self.text(x, y + i * gap, s, size=size, **kw)

    def _marker(self, color):
        mid = "m" + color.lstrip("#")
        if mid not in self.markers:
            self.markers.add(mid)
            self.add(
                f'<defs><marker id="{mid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
                f'orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{color}"/></marker></defs>'
            )
        return mid

    def arrow(self, pts, color=MUTED, sw=1.8, dash=None, both=False):
        mid = self._marker(color)
        d = " ".join(("M" if i == 0 else "L") + f"{x},{y}" for i, (x, y) in enumerate(pts))
        da = f' stroke-dasharray="{dash}"' if dash else ""
        start = f' marker-start="url(#{mid})"' if both else ""
        self.add(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{sw}"{da} marker-end="url(#{mid})"{start}/>')

    def save(self, name):
        body = "\n".join(self.parts)
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" height="{self.h}" '
            f'viewBox="0 0 {self.w} {self.h}">\n<rect width="100%" height="100%" fill="#ffffff"/>\n{body}\n</svg>\n'
        )
        (OUT / name).write_text(svg)


# ---------------------------------------------------------------------------
# Architecture diagram
# ---------------------------------------------------------------------------

def architecture():
    s = Svg(1600, 1150)
    s.text(800, 46, "MedChain — System Architecture", size=26, weight="bold", anchor="middle")
    s.text(800, 72, "Blockchain-based medicine provenance, scratch-code verification and accountable recalls",
           size=14, fill=MUTED, anchor="middle")

    # Layer bands
    bands = [
        (96, 108, "USERS"),
        (222, 258, "CLIENT"),
        (498, 200, "SERVICES"),
        (716, 260, "BLOCKCHAIN"),
        (994, 140, "DATA PLACEMENT"),
    ]
    for i, (y, h, label) in enumerate(bands):
        s.rect(20, y, 1560, h, fill="#fafafa" if i % 2 == 0 else "#ffffff", stroke="#e5e7eb", rx=6, sw=1)
        s.text(36, y + 24, label, size=11, weight="bold", fill="#6b7280")

    # Users
    uf, us = PALETTE["user"]
    s.rect(190, 112, 260, 78, uf, us)
    s.text(320, 140, "Contract Owner (admin)", 15, "bold", anchor="middle")
    s.text(320, 162, "registers roles · sets recall window", 12, fill=MUTED, anchor="middle")
    s.text(320, 178, "MetaMask wallet", 11, fill=MUTED, anchor="middle", italic=True)

    s.rect(490, 112, 360, 78, uf, us)
    s.text(670, 140, "Supply-chain actors", 15, "bold", anchor="middle")
    s.text(670, 162, "Manufacturer · Supplier · Distributor · Seller", 12, fill=MUTED, anchor="middle")
    s.text(670, 178, "MetaMask wallet per role", 11, fill=MUTED, anchor="middle", italic=True)

    pf, ps = PALETTE["patient"]
    s.rect(890, 112, 290, 78, pf, ps)
    s.text(1035, 140, "Patient / Consumer", 15, "bold", anchor="middle")
    s.text(1035, 162, "scratches pack code · no wallet needed", 12, fill=MUTED, anchor="middle")
    s.text(1035, 178, "device key pair in browser", 11, fill=MUTED, anchor="middle", italic=True)

    # Client
    cf, cs = PALETTE["client"]
    s.rect(190, 236, 990, 236, cf, cs, sw=2)
    s.text(210, 262, "Web client", 16, "bold", fill=cs)
    s.text(1060, 262, "Next.js 16 · React 19 · TypeScript · Tailwind / shadcn-ui", 13, fill=MUTED, anchor="end")
    s.text(210, 286, "Pages", 11, "bold", fill="#6b7280")
    pages = [("Dashboard", "/"), ("Register Roles", "/register-roles"), ("Order Materials", "/order-materials"),
             ("Supply Materials", "/supply-materials"), ("Track Materials", "/track-materials"),
             ("Recalls", "/recall"), ("Verify a Pack", "/verify")]
    for i, (name, path) in enumerate(pages):
        x = 210 + i * 137
        highlight = name == "Verify a Pack"
        s.rect(x, 294, 126, 58, "#ffffff", ps if highlight else cs, rx=8, sw=1.4)
        s.text(x + 63, 318, name, 12.5, "bold", anchor="middle")
        s.text(x + 63, 338, path, 10.5, fill=MUTED, anchor="middle", mono=True)

    s.text(210, 376, "Libraries (src/lib)", 11, "bold", fill="#6b7280")
    libs = [
        ("web3.ts · supplyChain.ts", ["MetaMask connection and", "contract calls (web3.js 4)"]),
        ("batchCodes.ts", ["pack secrets, leaves, Merkle root,", "codes CSV (@openzeppelin/merkle-tree)"]),
        ("api.ts", ["HTTP client for the MedChain", "server (verify, claim, proofs)"]),
        ("customerStore.ts", ["device key pair and claimed packs;", "re-checks for recalls every 30 s"]),
    ]
    for i, (name, desc) in enumerate(libs):
        x = 210 + i * 240
        s.rect(x, 384, 230, 76, "#ffffff", cs, rx=8, sw=1.2)
        s.text(x + 12, 405, name, 12, "bold", mono=True)
        s.lines(x + 12, 425, desc, size=11, fill=MUTED, gap=15)

    # Users -> client
    s.arrow([(400, 190), (400, 292)], us)
    s.arrow([(680, 190), (680, 292)], us)
    s.arrow([(1095, 190), (1095, 292)], ps)
    s.text(410, 214, "admin actions", 11, fill=MUTED)
    s.text(690, 214, "create · move · recall batches", 11, fill=MUTED)
    s.text(1085, 214, "verify · claim", 11, fill=MUTED, anchor="end")

    # Services
    wf, ws = PALETTE["wallet"]
    s.rect(190, 512, 370, 172, wf, ws, sw=2)
    s.text(210, 540, "MetaMask wallet", 16, "bold", fill=ws)
    s.lines(210, 566, ["EIP-1193 browser provider", "Holds staff private keys",
                       "Signs every state-changing transaction", "(stage moves, recall, quarantine, ack)"],
            size=12.5, fill=MUTED, gap=19)

    sf, ss = PALETTE["service"]
    s.rect(620, 512, 560, 172, sf, ss, sw=2)
    s.text(640, 540, "MedChain server", 16, "bold", fill=ss)
    s.text(780, 540, "Node.js · Express · ethers v6", 13, fill=MUTED)
    routes = ["POST /api/batches/:id/leaves", "GET  /api/batches/:id/proof/:serial", "POST /api/verify",
              "POST /api/claim  (relayed)", "GET  /api/units/:id/:serial", "GET  /api/batches/:id/provenance"]
    s.lines(640, 566, routes, size=11, mono=True, gap=18)
    s.rect(918, 556, 246, 54, "#ffffff", ss, rx=8, sw=1.2)
    s.text(930, 576, "Relayer signer", 12, "bold")
    s.text(930, 596, "pays gas · one tx at a time", 11, fill=MUTED)
    s.rect(918, 618, 246, 54, "#ffffff", ss, rx=8, sw=1.2)
    s.text(930, 638, "File store  server/data/*.json", 12, "bold")
    s.text(930, 658, "leaf hashes per batch (no secrets)", 11, fill=MUTED)

    # Client -> services
    s.arrow([(325, 460), (325, 510)], cs)
    s.text(335, 490, "sign tx", 11, fill=MUTED)
    s.arrow([(660, 460), (660, 510)], cs)
    s.text(670, 490, "upload leaves", 11, fill=MUTED)
    s.arrow([(1095, 352), (1095, 372), (1170, 372), (1170, 490), (1060, 490), (1060, 510)], ps)
    s.text(1050, 482, "verify · claim (HTTP)", 11, fill=MUTED, anchor="end", halo=True)

    # Blockchain
    nf, ns = PALETTE["chain"]
    s.rect(190, 730, 990, 236, "#ffffff", ns, sw=2, dash="7 4")
    s.text(210, 756, "Ethereum-compatible network", 16, "bold", fill=ns)
    s.text(450, 756, "Ganache (127.0.0.1:7545)  /  Hardhat Network (chain ID 1337)", 13, fill=MUTED)
    s.rect(210, 770, 950, 182, nf, ns, sw=1.6)
    s.text(228, 794, "SupplyChain.sol", 15, "bold", mono=True)
    s.text(380, 794, "Solidity 0.8.19 · single contract · OpenZeppelin MerkleProof + ECDSA", 12.5, fill=MUTED)
    modules = [
        ("Role registry", ["onlyOwner add*()", "actorIdOf O(1) lookup"]),
        ("Batch lifecycle", ["5 role-gated stages", "notRecalled guard"]),
        ("Pack verification", ["Merkle root / batch", "unitStatus() view"]),
        ("Pack claim", ["claimUnit / ...For", "EIP-191 signature"]),
        ("Recall", ["recall · quarantine", "ackRecall · escalate"]),
        ("Closure report", ["quarantined+claimed", "+unaccounted = qty"]),
    ]
    for i, (name, desc) in enumerate(modules):
        x = 228 + i * 153
        s.rect(x, 808, 145, 92, "#ffffff", ns, rx=8, sw=1.2)
        s.text(x + 72.5, 832, name, 12.5, "bold", anchor="middle")
        s.lines(x + 72.5, 856, desc, size=11, fill=MUTED, anchor="middle", gap=17)
    s.text(228, 930, "Events:", 11.5, "bold", fill=MUTED)
    s.text(282, 930, "BatchRegistered · ProductStageUpdated · UnitClaimed · BatchRecalled · UnitsQuarantined · "
           "RecallAcknowledged · RecallEscalated", 11, fill=MUTED, mono=False)

    # Services -> chain
    s.arrow([(375, 684), (375, 728)], ws)
    s.text(385, 706, "signed txs + reads (JSON-RPC)", 11, fill=MUTED)
    s.arrow([(760, 684), (760, 728)], ss)
    s.text(770, 706, "view calls: unitStatus, closureReport", 11, fill=MUTED)
    s.arrow([(1040, 684), (1040, 728)], ss)
    s.text(1050, 706, "relayed claimUnitFor", 11, fill=MUTED)

    # Dev column
    df, ds = PALETTE["dev"]
    s.rect(1270, 236, 290, 730, df, ds, sw=2)
    s.text(1415, 264, "Development & deployment", 15, "bold", anchor="middle", fill=ds)
    s.text(1415, 284, "backend/ — Hardhat 2.27 · TypeScript", 11.5, fill=MUTED, anchor="middle")
    dev = [
        ("Compile", ["solc 0.8.19, optimizer 200 runs", "ABI → client/src/artifacts"]),
        ("Test", ["33 Mocha/Chai tests (passing)", "hardhat-gas-reporter"]),
        ("Deploy", ["scripts/deploy.ts", "address → deployments.json"]),
        ("Local chain", ["Ganache GUI on port 7545", "relayer = account #9"]),
        ("Typechain", ["typed contract bindings", "for tests and scripts"]),
    ]
    for i, (name, desc) in enumerate(dev):
        y = 304 + i * 128
        s.rect(1290, y, 250, 104, "#ffffff", ds, rx=8, sw=1.2)
        s.text(1306, y + 28, name, 13.5, "bold")
        s.lines(1306, y + 54, desc, size=11.5, fill=MUTED, gap=19)

    s.arrow([(1270, 330), (1182, 330)], ds, dash="5 4")
    s.text(1226, 318, "ABI + address", 10.5, fill=MUTED, anchor="middle", halo=True)
    s.arrow([(1270, 560), (1182, 560)], ds, dash="5 4")
    s.text(1226, 548, "ABI + address", 10.5, fill=MUTED, anchor="middle", halo=True)
    s.arrow([(1270, 860), (1182, 860)], ds, dash="5 4")
    s.text(1226, 848, "deploy", 10.5, fill=MUTED, anchor="middle", halo=True)

    # Data placement
    cols = [
        ("On-chain (SupplyChain.sol)", nf, ns, ["Actors and roles; batch root, quantity, manufacturer",
                                                "Batch stage, unit state and anonymous claimant key",
                                                "Recall deadline, holders, acks, escalations"]),
        ("Server (server/data/*.json)", sf, ss, ["Public leaf hash of every pack, per batch",
                                                 "Accepted only if leaves rebuild the on-chain root",
                                                 "Cannot forge a code: the contract checks proofs"]),
        ("Browser / paper only", pf, ps, ["Scratch secrets: codes CSV → printer → pack",
                                          "Customer private key (generated on the phone)",
                                          "List of packs claimed on this device"]),
    ]
    for i, (title, f, st, desc) in enumerate(cols):
        x = 190 + i * 460
        s.rect(x, 1010, 440, 112, f, st, sw=1.5)
        s.text(x + 16, 1036, title, 13.5, "bold", fill=st)
        s.lines(x + 16, 1060, desc, size=12, fill=INK, gap=19)

    s.save("architecture.svg")


# ---------------------------------------------------------------------------
# Methodology diagram
# ---------------------------------------------------------------------------

def methodology():
    s = Svg(1600, 480)
    s.text(800, 46, "MedChain — Methodology", size=26, weight="bold", anchor="middle")
    s.text(800, 72, "From batch creation to recall, every step is recorded on the blockchain",
           size=14, fill=MUTED, anchor="middle")

    phases = [
        ("Setup", PALETTE["owner"], ["Deploy smart contract", "Owner registers roles", "Set recall window"]),
        ("Batch creation", PALETTE["maker"], ["Secret code for each pack", "Build Merkle root", "Store root on blockchain"]),
        ("Custody transfer", PALETTE["actor"], ["Supplier → Manufacturer", "Distributor → Seller", "Each move recorded on-chain"]),
        ("Verify & claim", PALETTE["patient"], ["Patient enters scratch code", "Contract checks the proof", "Genuine pack is claimed"]),
        ("Recall", PALETTE["service"], ["Manufacturer recalls batch", "Holders quarantine & confirm", "Closure report generated"]),
    ]

    col_w, gap, x0 = 288, 20, 40
    box_h, step_gap, top = 64, 24, 196
    for ci, (title, (f, st), steps) in enumerate(phases):
        x = x0 + ci * (col_w + gap)
        cx = x + col_w / 2
        s.rect(x, 104, col_w, 64, st, st, rx=12)
        s.text(cx, 130, f"STEP {ci + 1}", 12, "bold", fill="#ffffff", anchor="middle")
        s.text(cx, 154, title, 18, "bold", fill="#ffffff", anchor="middle")
        if ci < len(phases) - 1:
            s.arrow([(x + col_w + 2, 136), (x + col_w + gap - 2, 136)], INK, sw=2)
        for si, step in enumerate(steps):
            y = top + si * (box_h + step_gap)
            s.rect(x, y, col_w, box_h, f, st, sw=1.5)
            s.text(cx, y + box_h / 2 + 5, step, 15, "normal", anchor="middle")
            if si < len(steps) - 1:
                s.arrow([(cx, y + box_h + 2), (cx, y + box_h + step_gap - 2)], MUTED, sw=1.6)

    s.save("methodology.svg")


if __name__ == "__main__":
    architecture()
    methodology()
    print("wrote architecture.svg and methodology.svg")
