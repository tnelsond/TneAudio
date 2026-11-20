plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.usbrecorder.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.usbrecorder.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Signed with the debug key so the APK installs directly (sideload).
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    // Bundle the web app (../web) as assets/www
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/webassets"))
}

val copyWeb by tasks.registering(Copy::class) {
    from(rootProject.file("../web")) {
        include("index.html", "app.js", "worklets.js", "styles.css", "manifest.webmanifest", "icons/**")
    }
    into(layout.buildDirectory.dir("generated/webassets/www"))
}
tasks.named("preBuild") { dependsOn(copyWeb) }

dependencies {
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.webkit:webkit:1.12.1")
}
