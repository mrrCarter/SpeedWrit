import { useEffect, useRef, useState } from "react";
import { tamperOneByte, verifyReceipt, type Signer, type Verification } from "../domain/crypto";
import type { Receipt } from "../domain/types";
import { useEngine, useEngineState } from "../engineContext";
import { verifyStore } from "../explain";
import { Card, Chip, short } from "./ui";

export function Verify() {
  const s = useEngineState();
  const engine = useEngine();
  const [signer, setSigner] = useState<Signer | null>(null);
  const [seq, setSeq] = useState<number>(0);
  const [tampered, setTampered] = useState(false);
  const [check, setCheck] = useState<Verification | null>(null);
  const [all, setAll] = useState<{ ok: number; bad: number } | null>(null);
  const lifetime = useRef(0);

  useEffect(() => {
    void engine.signer.then(setSigner);
  }, [engine]);

  const list = s.receipts;
  const selected = list.find((r) => r.seq === seq) ?? list[list.length - 1];
  const subject: Receipt | undefined = selected && tampered ? tamperOneByte(selected) : selected;

  useEffect(() => {
    setCheck(null);
    // Ignore checks that finish after their input, receipt list, or mounted view changes.
    return () => { lifetime.current++; };
  }, [engine, seq, tampered, s.rev]);

  useEffect(() => {
    setAll(null);
  }, [engine, s.rev]);

  const verify = async () => {
    if (!signer || !subject) return;
    const generation = engine.generation;
    const view = lifetime.current;
    const v = await verifyReceipt(subject, signer, list[subject.seq - 2]);
    if (generation !== engine.generation || view !== lifetime.current) return;
    setCheck(v);
    if (!tampered && v.hashOk && v.signatureOk) verifyStore.mark(generation);
  };
  const verifyAll = async () => {
    if (!signer) return;
    const generation = engine.generation;
    const view = lifetime.current;
    let ok = 0;
    let bad = 0;
    for (const [i, r] of list.entries()) {
      const v = await verifyReceipt(r, signer, list[i - 1]);
      if (generation !== engine.generation || view !== lifetime.current) return;
      if (v.hashOk && v.signatureOk && v.chainOk && v.keyOk) ok += 1;
      else bad += 1;
    }
    setAll({ ok, bad });
  };

  const Line = ({ label, ok }: { label: string; ok: boolean }) => (
    <div className="row"><Chip tone={ok ? "ok" : "bad"}>{ok ? "valid" : "invalid"}</Chip><span>{label}</span></div>
  );

  return (
    <div className="grid g2" style={{ alignItems: "start" }}>
      <Card title="Verify a receipt in the browser">
        <p className="muted">Recomputes the hash from the receipt's own fields, checks the signature with the public key, and checks the link to the previous receipt.</p>
        <div className="row" style={{ marginBottom: 10 }}>
          <select className="btn" value={selected?.seq ?? 0} onChange={(e) => { setSeq(Number(e.target.value)); setTampered(false); }}>
            {[...list].reverse().map((r) => <option key={r.seq} value={r.seq}>#{r.seq} {r.type}{r.reason ? ` · ${r.reason}` : ""}</option>)}
          </select>
          <label className="row"><input type="checkbox" checked={tampered} onChange={(e) => setTampered(e.target.checked)} /> change one byte</label>
          <span className="spacer" />
          <button className="btn primary" onClick={verify} disabled={!signer}>Verify</button>
        </div>
        {check && (
          <div className="rows" style={{ marginBottom: 10 }}>
            <Line label="hash matches content" ok={check.hashOk} />
            <Line label="signature over the hash" ok={check.signatureOk} />
            <Line label="links to the previous receipt" ok={check.chainOk} />
            <Line label="signed by the pinned key" ok={check.keyOk} />
          </div>
        )}
        {subject && <pre className="mono-box">{JSON.stringify(subject, null, 2)}</pre>}
      </Card>
      <div className="grid">
        <Card title="Signing key">
          <div className="rule"><span className="k">algorithm</span><span>{signer?.alg ?? "…"}</span></div>
          <div className="rule"><span className="k">key id</span><span>{signer?.keyId ?? "…"}</span></div>
          <div className="rule"><span className="k">public key</span><span className="hash" style={{ wordBreak: "break-all" }}>{signer?.publicKey ?? "…"}</span></div>
          <p className="faint" style={{ marginTop: 8 }}>Generated in this browser tab on load; it never leaves the page.</p>
        </Card>
        <Card title="Whole chain" right={<button className="btn" onClick={verifyAll} disabled={!signer}>Verify all {list.length}</button>}>
          {all ? (
            <p>{all.bad === 0 ? <span className="pass">All {all.ok} receipts verify.</span> : <span className="fail">{all.bad} receipt(s) fail.</span>}</p>
          ) : (
            <p className="muted">Checks every receipt and every link, newest {short(list[list.length - 1]?.hash, 12)}.</p>
          )}
        </Card>
      </div>
    </div>
  );
}
