// R23.6M Phase B1/B2/B3 — NAgex Android Companion app module.
//
// Dependencies are deliberately minimal: OkHttp for the authenticated
// HTTPS client (matching the signed-envelope transport's JSON shape), and
// standard AndroidX. No design-system library, no DI framework — Phase B's
// own directive is "do not build a large mobile design system."
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.nagex.mobile"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.nagex.mobile"
        // SpeechRecognizer/TextToSpeech/ContactsContract are all available
        // well below this; 26 is chosen for Ed25519 (java.security, via
        // Conscrypt/BoringSSL on-device) and modern permission-model
        // support without carrying compat shims for API levels R23.6M's
        // own MVP scope doesn't need to support.
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0-r23.6m-phase-b"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        viewBinding = true
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.json:json:20240303")

    testImplementation("junit:junit:4.13.2")
    // R23.6M Phase B4 — Robolectric runs real Android framework shadows
    // (permission checks, ContentResolver/ContactsContract, TextToSpeech)
    // as plain JVM unit tests, no emulator/device required. Used only
    // where it provides genuinely truthful coverage of the disclosed
    // Phase B gaps (permission denial, contact query scoping, TTS
    // fallback) — not for anything that needs a real device driver.
    testImplementation("org.robolectric:robolectric:4.13")
    testImplementation("androidx.test:core:1.6.1")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
}

// This repository's absolute path contains non-ASCII (Korean) characters
// (a fixed, external constraint — see gradle.properties's
// android.overridePathCheck note). Gradle's forked unit-test worker JVM
// does not inherit org.gradle.jvmargs's -Dfile.encoding=UTF-8 (that only
// applies to the Gradle daemon itself), so on a Windows host whose default
// codepage is not UTF-8, the worker can fail to resolve its own classpath
// entries under this path (observed: every test class throwing
// ClassNotFoundException at initialization, never a real per-test
// failure). Setting both file.encoding and sun.jnu.encoding explicitly on
// the forked worker fixes this at the source rather than depending on the
// invoking shell's console codepage.
tasks.withType<Test> {
    jvmArgs("-Dfile.encoding=UTF-8", "-Dsun.jnu.encoding=UTF-8")
}
