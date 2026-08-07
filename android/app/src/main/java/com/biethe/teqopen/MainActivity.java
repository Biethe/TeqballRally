package com.biethe.teqopen;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // The opening clip is the first thing the app plays and there has been
        // no tap yet, so without this the WebView would only let it start
        // muted. A browser tab still applies its own gesture rule; the web
        // build falls back to muted playback there.
        getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
    }
}
