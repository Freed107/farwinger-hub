# PERDIMI — audience demographics per successful reel on the Estate Board (Fred, 2026-11-25)

For: the PC session that owns the Global Estate Dashboard / online Estate Board and the daily 07:20 readers.
Fred's request: for every successful PERDIMI reel, show gender %, age and location. Visual density is fine;
the board does not need to stay minimal.

## 0. What the platforms actually give (check against the live API before building; do not assume)

| Platform | Per-reel demographics via API? | What to use |
|---|---|---|
| Instagram (Graph API) | **No.** Media insights give views, reach, saves, shares, watch time; no age/gender/country per media. | Account-level `reached_audience_demographics` and `engaged_audience_demographics` (breakdown `age`, `gender`, `country`, `city`, timeframe `this_week` / `this_month`). Only returned once the account has 100+ reached/engaged accounts in that window. |
| Instagram app | Yes: per-reel "Audience" tab (gender, age, top countries) once a reel has enough views. | Not in the API. Do not scrape it with the automation browser unless Fred says yes: account risk. |
| TikTok | Check the TikTok for Business account API video insights for per-video audience gender and country. If the account is Personal, there is nothing to read. | Use per-video data where it exists. |
| Facebook Page | Per-post demographic breakdowns were removed. | Page-level only. Skip unless it's cheap. |

Reality check: PERDIMI averages about 120 views per post (79 on Instagram). Under the 100-account threshold
Instagram returns nothing, so expect **blank demographics on most reels until reach grows.** The board must
show "not enough reach for demographics (<100)" and not an empty chart or a guess.

## 1. Definition of "successful reel"

A reel qualifies if its views are **≥ 2× the account's 30-day median** for that platform, or it is in the top 3
on that platform for the month. Recompute daily. A reel that qualified once keeps its panel.

## 2. Data (07:20 daily reader, same run that already reads PERDIMI views)

- For each qualifying reel: store `demographics = {source, scope, read_at, n, gender:{f,m,u}, age:{13-17,18-24,25-34,35-44,45-54,55-64,65+}, countries:[top5 %], cities:[top5 %]}`.
- `scope` is `"reel"` (per-video, e.g. TikTok) or `"account-window"` (Instagram: the account's reached audience for the
  7 days after the reel went up, attributed to the reel). Never label account-window data as per-reel.
- Store percentages, plus `n` (accounts reached/engaged that the split is based on).

## 3. Board (local dashboard + online Estate Board)

Under the PERDIMI section, add a **"Who watched" strip**: one card per qualifying reel, newest first.

Each card:
1. Thumbnail, platform icon, post date, views, and a "×N median" badge.
2. **Gender:** one 100 % stacked bar, female / male / unknown, with percentages printed on it.
3. **Age:** 7 small vertical bars (13–17 … 65+), with the biggest bucket labelled.
4. **Location:** top 3 countries and top 3 cities as `🇬🇧 UK 41 %`-style rows (use the board's existing flag images).
5. Footer: `scope: per reel` or `scope: account, 7 days after post`, plus `n=` and the read date.
   Grey the card out with "<100 reached, no split from Instagram" when there is no data.

Above the strip: a single **PERDIMI 30-day audience** card (same three blocks, account-level) as the baseline,
so each reel card can be compared with it. Mark buckets that differ by ±10 pts from the baseline.

## 4. Done when

- The reader writes the demographics for every qualifying reel (or the explicit "no data" reason) and they show on both boards.
- One screenshot of the strip goes to Fred.
- No browser scraping of Instagram insights without Fred's explicit yes.

## 5. Field data from Fred (Instagram app, 25 Nov 2026) — seed the board with these

| Reel | Top countries | Non-followers | Likes / saves |
|---|---|---|---|
| Posted while Fred was in Turkey (hair/arm, car park) | TR 23.3, US 9.4, DE 8.8, FR 5.7, IT 4.8 | 99 % | 16 / 8 |
| Jewellery close-up (black lace) | SA 18.6, IR 16.2, IQ 5.9, MA 4.4, BH 4.4 | 97 % | 4 / 1 |
| Street / group in black coats | IN 33.7, TR 8, UK 6.7, IR 6.1, PK 3.7 | 95 % | 2 / 1 |

- Fred: posting from Turkey got more views in Turkey. Add a `posted_from` field (country) per reel and show it on the card.
- The UK share is small on every reel and followers are almost nobody. Flag a reel's top country when it's outside the target market.
- The Instagram app DOES show per-reel country/age/gender (Audience tab). The API doesn't. Until there's a sanctioned way in,
  Fred enters it by hand: add a small "paste audience" form on the board (top 5 countries %, gender %, top age band).
