# FieldSync — Manual Testing Checklist (field pilot)

For the person preparing a pilot: run this checklist on **real phones** before any CHW uses
FieldSync, and again after every release. Automated tests (see [QA-REPORT.md](QA-REPORT.md))
run in desktop Chromium with emulated networks; they cannot prove behaviour on a
three-year-old Android phone on 2G in the sun. That is what this checklist is for.

> Run this checklist with test accounts and made-up patients only, never with real patient records.

Record each result as ✅ pass, ❌ fail (with the support code and a photo of the screen), or
➖ not applicable. A pilot starts only when every **Blocking** item passes.

---

## 0. Test set-up

| Item | Done |
|---|---|
| At least **3 phones**: one low-end Android (≤ 2 GB RAM, Android 8–10), one mid-range Android, one iPhone (installed to home screen) | ☐ |
| Chrome / Android System WebView version recorded for each phone (must be ≥ 87) | ☐ |
| Free storage recorded for each phone (Settings → Storage) | ☐ |
| A staging server with a valid HTTPS certificate, `FIELDSYNC_DEMO_MODE` **off** for sections 1–9 | ☐ |
| Demo accounts from `make seed` (CHW, supervisor, admin), passwords handed over privately | ☐ |
| A SIM with **2G only** mode available, or a router that can throttle | ☐ |
| A notebook to write receipt codes and support codes | ☐ |

---

## 1. Install and first sign-in — **Blocking**

| # | Step | Expected | Result |
|---|---|---|---|
| 1.1 | Open the staging URL in Chrome | Login screen in < 10 s on 3G; no horizontal scrolling | |
| 1.2 | Chrome menu → **Install app** | FieldSync icon on the home screen; opens without the browser bar | |
| 1.3 | Sign in as the CHW **with network** | Signs in (first time takes a few seconds); Home shows **No forms yet** | |
| 1.4 | Wait for **FieldSync is ready to work offline on this phone.** | Message appears within ~1 min on 3G | |
| 1.5 | **Settings → Device check** | All items OK or explained; *Storage protected: Yes* on installed Android | |
| 1.6 | Airplane mode on, close FieldSync fully, reopen it | App opens offline; asks for password if locked; Home works | |
| 1.7 | Offline, sign in on a phone where this account has **never** signed in | Clear message: first sign-in needs network | |

## 2. Capture offline — **Blocking**

| # | Step | Expected | Result |
|---|---|---|---|
| 2.1 | Airplane mode. **New form → Sick child visit**, fill all steps, **Save form** | **Saved on this phone** with a receipt code; Home: **1 form waiting to send** | |
| 2.2 | Start a second form, answer half, press the phone's Home button, kill FieldSync from recent apps | Reopen → **Unfinished forms → Continue** → every answer still there, same step | |
| 2.3 | Enter an impossible answer (age 80 months on an under-5 form) | Message under the question; **Next** does not continue | |
| 2.4 | Answer so that a follow-up question appears (fever = Yes), then change it back | Follow-up appears and disappears; hidden answer is not saved | |
| 2.5 | Save **20 forms** offline as fast as realistically possible | No slowdown you can feel; each save < 1 s | |
| 2.6 | Restart the phone (power off/on), still offline | All 20 forms still **Waiting** | |

## 3. Sending — **Blocking**

| # | Step | Expected | Result |
|---|---|---|---|
| 3.1 | Turn network on, FieldSync open | Sending starts within ~30 s by itself; Home ends at **All forms sent** | |
| 3.2 | Repeat 2.1 offline, then turn network on with **FieldSync closed** (Android) | Forms are sent without opening the app (check the supervisor dashboard or reopen later) | |
| 3.3 | Save 30 forms offline, turn network on, switch airplane mode on **while Sending…** | Forms that did not finish show **Will retry**; none lost | |
| 3.4 | Turn network back on | Remaining forms send. On the server each form exists **exactly once** (supervisor/admin check) | |
| 3.5 | 2G-only mode: send 25 forms | All sent; no error message; record the time: ____ | |
| 3.6 | Compare receipt codes from your notebook with the server (admin) | Every code found once | |

## 4. Problems a CHW must handle — **Blocking**

| # | Step | Expected | Result |
|---|---|---|---|
| 4.1 | Supervisor changes a sent form on the server; CHW edits the same form on the phone and saves | **Changed on server** → comparison screen; **Combine both** keeps both changes | |
| 4.2 | Both change the **same** answer | Screen asks to choose; the chosen version is on the server afterwards | |
| 4.3 | Leave a phone offline > 30 days (or have the admin change `JWT_SIGNING_KEY` on staging), save a form, reconnect | **Sign in again to send your saved forms**; after signing in the form sends | |
| 4.4 | Admin retires the template version a queued form uses (staging), then reconnect | **Needs fixing** → *form type replaced* → **Fix and send again** moves answers to the new version → sends | |
| 4.5 | Fill the phone's storage (copy large videos) and save a form | **Phone storage is full** banner; you stay on the form; after deleting the videos, **Save form** works | |
| 4.6 | Any error with a support code | Code shown (FS-xxxxxx); admin finds the request in the logs with it (MAINTENANCE §12) | |

## 5. Security and shared phones — **Blocking**

| # | Step | Expected | Result |
|---|---|---|---|
| 5.1 | Leave FieldSync idle for 5 minutes | Locks itself; PIN or password needed | |
| 5.2 | Wrong password 6 times offline (5 free tries) | Waiting time enforced; correct password works after it | |
| 5.3 | CHW A saves 2 forms offline → **Settings → Switch user** → CHW B signs in (online) | B sees none of A's forms | |
| 5.4 | B switches back to A (offline) | A's 2 forms still waiting; they send when online | |
| 5.5 | A's password does not open B's account and vice versa | Refused | |
| 5.6 | Supervisor revokes a phone that has 1 unsent form; phone reconnects | **This phone was removed…**; data erased; sign-in impossible on that device record | |
| 5.7 | Admin resets CHW's password while the phone holds unsent forms; CHW signs in **online** with the new password | Unsent forms still there and send | |
| 5.8 | **Sign out and erase** with unsent forms | Must type the number of unsent forms; cancelling keeps everything | |
| 5.9 | Inspect browser storage (chrome://inspect on a test phone) | Form answers are unreadable ciphertext; no names or answers in plain text | |

## 6. Updates

| # | Step | Expected | Result |
|---|---|---|---|
| 6.1 | Deploy a new version while a phone has a form **open** | **A new version … is ready**; it does not reload until the form is saved | |
| 6.2 | Tap **Update now** on Home | Reloads to the new version; waiting forms still there | |
| 6.3 | A phone offline during the deploy | Keeps working on the old version; updates after reconnecting | |

## 6b. Network meter

| # | Step | Expected | Result |
|---|---|---|---|
| 6b.1 | Good 3G/4G signal | Header shows 3–4 bars (**Good**/**Strong**); details show a server response time | |
| 6b.2 | 2G-only mode | 1–2 bars (**Weak**/**Fair**) within a minute | |
| 6b.3 | Airplane mode | **Offline** at once | |
| 6b.4 | Connect to Wi-Fi with a sign-in page (captive portal) but do not sign in | **No server** after about a minute; forms are not marked failed | |
| 6b.5 | Leave FieldSync in the background for 1 h on mobile data | Mobile data used by FieldSync stays near zero (no probes in the background) | |

## 6c. Form builder (national admin, on a computer)

| # | Step | Expected | Result |
|---|---|---|---|
| 6c.1 | **Forms → New form**, build a 2-step form with a yes/no question and a choice shown only on "Yes" | Every change shows **All changes saved**; preview hides/shows the choice | |
| 6c.2 | Enter an impossible rule (lowest 10, highest 5) | A problem is listed with its step and question; nothing is saved until fixed | |
| 6c.3 | **Publish**; a CHW phone signs in (or reopens online) | The new form appears under **New form** and can be completed offline | |
| 6c.4 | **New version** of it, add a question, publish | Phones get version 2; forms saved on version 1 still send for 30 days | |
| 6c.5 | **Retire** version 1 while a phone holds a v1 form | That form shows *replaced by a newer version*; **Fix and send again** moves it to v2 | |
| 6c.6 | Open the builder on a phone | Usable without sideways scrolling; Edit/Preview tabs | |

## 7. Supervisor dashboard

| # | Step | Expected | Result |
|---|---|---|---|
| 7.1 | Supervisor signs in | Only their county's facilities | |
| 7.2 | A CHW phone with forms waiting reports in | Facility shows forms waiting on phones and the age of the oldest | |
| 7.3 | That phone sends everything | Within a minute the dashboard no longer shows its forms as waiting | |
| 7.4 | A facility with no phone activity | **No data**, not "Not syncing" | |
| 7.5 | Dashboard offline (airplane mode) | Last snapshot with its time; clearly marked as not live | |

## 8. Usability in the field

| # | Step | Expected | Result |
|---|---|---|---|
| 8.1 | Direct sunlight, **Outdoor** theme | Every label readable at arm's length | |
| 8.2 | Low-end phone, 5 CHWs each complete one form **without help** | Note where they hesitate: ____ | |
| 8.3 | CHWs explain the labels **Waiting / Will retry / Sent** in their own words | Matches the User Guide | |
| 8.4 | Large text (Android font size largest) | Nothing cut off; buttons still usable | |
| 8.5 | TalkBack on: complete a form | Every field, error and button is announced; focus moves to the new step heading | |
| 8.6 | Language switch (placeholder ⟦kpe⟧) | Every screen changes; layouts do not break | |

## 9. Battery and data use (informational)

| # | Measure | Value |
|---|---|---|
| 9.1 | Mobile data for first sign-in + offline install | ____ KB |
| 9.2 | Mobile data to send 25 forms | ____ KB |
| 9.3 | Battery used in a 4-hour session with 15 forms | ____ % |

## 10. Training simulator (demo mode only)

With `FIELDSYNC_DEMO_MODE` on in a **training** environment:

| # | Step | Expected | Result |
|---|---|---|---|
| 10.1 | **Settings → Offline sync simulator → Flaky**, add 50 forms, **Send now** | **Duplicates prevented** counts up; server keeps one copy each | |
| 10.2 | **Supervisor edits the last sent form**, then edit it on the phone | Conflict screen as in 4.1 | |

---

## Sign-off

| Role | Name | Date | Decision |
|---|---|---|---|
| Pilot lead | | | Go / No-go |
| County supervisor | | | |
| Technical lead | | | |
