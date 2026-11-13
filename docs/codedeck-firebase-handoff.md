# CodeDeck Firebase handoff

Firebase provisioning was verified on 10 November 2026. The Android client configuration is installed. The downloaded backend credential still needs to be moved into owner-only storage before configuring the managed service.

## Verified setup

| Item | Value |
| --- | --- |
| Firebase project | [CodeDeck](https://console.firebase.google.com/project/codedeck-companion/overview) · `codedeck-companion` |
| Plan | Spark. Google Analytics and Gemini were disabled during setup. |
| Android registration | `CodeDeck Android` · `com.codedeck.companion` |
| Firebase app ID | From the Firebase console Android app settings (do not commit) |
| Cloud Messaging | HTTP v1 enabled. Legacy API disabled. |
| Android configuration | `client/android/app/google-services.json` · ignored by Git |
| Backend service account | FCM-capable service account on `codedeck-companion` only (see console) |
| IAM grant | Firebase Cloud Messaging API Admin (`roles/firebasecloudmessaging.admin`) on `codedeck-companion` only |
| Backend credential | One active key. Keep the downloaded JSON outside the repository until it is secured below. |

The Android config and backend credential were both checked against `codedeck-companion`. The downloaded credential should be mode `0600` once secured. Keep the original download out of the repository and the APK.

## Local coding agent

1. Copy the verified download to `$HOME/.codedeck/firebase/service-account.json`. Use directory mode `0700` and file mode `0600`. If the destination already exists, verify its identity before proceeding. Check both files' `project_id` and the credential's `client_email` without printing credential contents. Verify the secured copy and its permissions before removing the Downloads copy. Keep the credential outside the repository and APK.
2. Set `CODEDECK_FIREBASE_CREDENTIALS=$HOME/.codedeck/firebase/service-account.json` in the managed backend's launch environment. Preserve the existing Tailscale owner and Serve origin settings described in the [Android companion release guide](android-companion.md). Get owner approval for the exact managed restart command before running it. After the restart, verify that the mobile capabilities endpoint reports `notificationsReady: true`.
3. Rebuild and sign with the existing release keystore. Run from the repository root after setting the SDK and JDK paths described in the release guide.

   ```sh
   npm run android:verify --workspace=client
   CODEDECK_ANDROID_SIGNING_PROPERTIES=$HOME/.codedeck/android-signing/release.properties \
     npm run android:release --workspace=client
   ```

   Verify the signature of `client/android/app/build/outputs/apk/release/app-release.apk`, then install it on the intended Android phone.

4. Enable notifications on that phone and trigger a CodeDeck test event while the app is backgrounded and again while the screen is locked. Confirm that the alert uses generic wording and opaque routing IDs, and that tapping it resolves the correct event over the private CodeDeck connection. Record the observed delivery and tap behavior. Keep terminal output, commands, paths, and project names out of the payload.

The managed restart, updated signed APK, and real-device delivery are pending. Keep Tailscale configuration and unrelated Firebase projects out of this handoff.
