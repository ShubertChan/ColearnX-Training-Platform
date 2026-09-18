import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
const browser = await chromium.launch({ timeout: 15000 });
try {
  const page = await browser.newPage();
  const bytes = await page.evaluate(async () => {
    const mimeType = ["video/mp4;codecs=avc1.42001f", "video/mp4"].find(value => MediaRecorder.isTypeSupported(value));
    if (!mimeType) throw Error("No MP4 recording support");
    const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext("2d"), stream = canvas.captureStream(12);
    let frame = 0;
    const draw = setInterval(() => { context.fillStyle = frame++ % 2 ? "#174e39" : "#20594b"; context.fillRect(0, 0, 320, 180); context.fillStyle = "white"; context.font = "24px sans-serif"; context.fillText("CoLearnX test " + frame, 32, 96); }, 80);
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 150000 }), chunks = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start(1000); await new Promise(resolve => setTimeout(resolve, 14000)); recorder.stop(); await stopped;
    clearInterval(draw); stream.getTracks().forEach(track => track.stop());
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  });
  const source = Buffer.from(bytes), boxes = []; let offset = 0;
  while (offset + 8 <= source.length) { const length = source.readUInt32BE(offset), type = source.toString("ascii", offset + 4, offset + 8); if (!length || length < 8 || offset + length > source.length) throw Error("Unexpected MP4 structure"); boxes.push({ offset, length, type }); offset += length; }
  const fragment = boxes.find(box => box.type === "moof");
  if (!fragment || !boxes.some(box => box.type === "moov")) throw Error("Recorder did not produce fragmented MP4");
  const folder = "tests/fixtures/hls"; await mkdir(folder, { recursive: true });
  await writeFile(folder + "/init.mp4", source.subarray(0, fragment.offset));
  await writeFile(folder + "/segment.m4s", source.subarray(fragment.offset));
  await writeFile(folder + "/master.m3u8", '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:15\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:14.0,\nsegment.m4s\n#EXT-X-ENDLIST\n');
  console.log(JSON.stringify({ bytes: source.length, boxes: boxes.map(box => box.type) }));
} finally { await browser.close(); }
