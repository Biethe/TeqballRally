# TeqRallly

A 3D teqball game. Play solo against the computer, learn the moves in Practice,
compete in a cup or league, or take on another player online.

## Platforms

- **Web browser.** Open **https://teqopen-4c7ae.web.app** — no install.
- **Android.** It is in a closed test on Google Play right now.

You can play with a keyboard, a gamepad or a touchscreen, holding your phone
either upright or sideways. Purchases (the arena, coin packs) only complete in
the Play Store build; everything you earn by playing is the same on both.

## Play in the browser

Share this link with anyone you want to try the game:

**https://teqopen-4c7ae.web.app**

Works on desktop and on a phone. Online matches need an internet connection.
A browser client and an Android client can play each other.

## Become an Android tester

1. Open the opt-in link on your Android phone, using the Google account you
   use for Play:
   **https://play.google.com/apps/testing/com.biethe.teqopen**
2. Tap **Become a tester**.
3. Install TeqRallly from the Play Store link on that page.

This is a closed test, so your Google account has to be on the testers list
first. If the link says you are not eligible, send your Gmail address to the
developer and ask to be added.

## How to launch

On the web, open the link above. On Android, open **TeqRallly** from your app
drawer like any other app. Online matches need an internet connection.

To run the game from source (you need the private art bundle):

```bash
npm install
npm run assets:fetch
npm run dev          # then open the URL it prints
```

## Demo

[Demo video](https://youtu.be/7pNp-_qSm34)

---

Developers: the design and the reasons behind it are in
[`docs/DESIGN.md`](docs/DESIGN.md).
