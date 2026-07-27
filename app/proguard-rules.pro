# CamSpy ProGuard rules
-keep class com.camspy.app.** { *; }
-keep class okhttp3.** { *; }
-keep class org.jsoup.** { *; }
-dontwarn okhttp3.**
-dontwarn org.jsoup.**
