# Limitations (padho, launch se pehle)

## Download ke bare me sach

"Sirf play, download nahi" **poori tarah enforce nahi ho sakta**. Browser ko video bytes mil rahe hain, to koi bhi tool (browser devtools, IDM, `curl`) valid stream URL se bytes utha sakta hai. Jo kiya gaya hai:

- Koi download button / `download` link nahi; right-click menu aur native "Save video as" controls band.
- Stream URL sirf 2× video length tak valid; uske baad `403`.
- URL ko address bar me kholne (Save-As), iframe/embed karne, ya dusri site se hot-link karne par `403`.
- Public site par metadata/listing nahi, id unguessable (96 bit).

Isse zyada chahiye (jaise DRM) to Telegram se direct streaming ka model badalna padega: ye is project ke scope se bahar hai.

## 4K

- File Telegram par jis quality me hai wahi stream hoti hai (4K file → 4K). Koi transcoding/adaptive bitrate nahi.
- 4K tabhi chalegi jab viewer ka browser/device codec decode kare (H.264, VP9, AV1 theek; HEVC/H.265 sirf kuch browsers me) aur uska internet bitrate sambhale.
- Throughput Telegram ke download speed aur VPS bandwidth se bandhi hai. Heavy parallel use par Telegram `FLOOD_WAIT` de sakta hai.
- MP4 me `moov` atom end me ho to start/seek slow hota hai: `ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4`.
- MKV/AVI jaise containers index hote hain par "unsupported" ho kar chhupe rehte hain.

## Verify nahi ho paya (is build environment me)

- **Real Telegram account ke saath end-to-end test nahi hua.** GramJS adapter sirf fake client ke saath test hua hai. Fix (`InputDocumentFileLocation` + datacenter id + read-ahead) gramjs ke source/behaviour ke hisaab se likha gaya hai, par pehla real playback tumhe test karna hoga.
- **Is environment me npm registry block thi**, isliye dependencies install nahi hui: `npm test` / `npm run typecheck` yahan **chalaye nahi gaye**. Naye aur badle hue tests (`public-play`, `admin-videos`, `streaming`, `reference-refresh`) likhe gaye hain par unka pehla run tumhari machine par hoga. Pehle `npm install && npm test && npm run typecheck` chalao.
- Docker/Caddy/systemd files execute nahi hui.
- GramJS upstream me archived hai (version pinned).
- Telegram ToS aur content ke rights tumhari zimmedari hai.
