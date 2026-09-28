// R23.6M — NAgex Android Companion App, root build file.
// Deliberately minimal: two plugins only (Android application + Kotlin
// Android). No design-system libraries, no DI framework, no navigation
// component — Phase B's own directive is "do not build a large mobile
// design system."
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
