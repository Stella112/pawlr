import json, subprocess, sys, time, os, concurrent.futures as cf
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
beats = json.load(open(os.path.join(root, "script.json"), encoding="utf-8"))
out = os.path.join(root, "public", "audio")
def dur(p):
    return float(subprocess.check_output(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",p], text=True).strip())
def make(b):
    p = os.path.join(out, b["id"] + ".mp3")
    for i in range(8):
        r = subprocess.run([sys.executable,"-m","edge_tts","--voice","en-US-AndrewMultilingualNeural","--rate=-4%","--text",b["text"],"--write-media",p], capture_output=True, text=True)
        if r.returncode == 0 and os.path.exists(p) and os.path.getsize(p) > 2000:
            return b["id"], dur(p)
        time.sleep(1.5)
    raise SystemExit("voice failed for " + b["id"])
with cf.ThreadPoolExecutor(3) as ex:
    res = dict(ex.map(make, beats))
meta = [{**b, "seconds": res[b["id"]], "words": len(b["text"].split())} for b in beats]
json.dump(meta, open(os.path.join(root, "beats.json"), "w", encoding="utf-8"), indent=1)
tot = sum(res.values())
print("beats", len(meta), "words", sum(m["words"] for m in meta), "audio seconds", round(tot,1))
for m in meta: print(m["id"], round(m["seconds"],1))
