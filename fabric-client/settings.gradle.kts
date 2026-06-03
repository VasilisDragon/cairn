pluginManagement {
    repositories {
        maven("https://maven.fabricmc.net/")
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_PROJECT)
    repositories {
        maven("https://maven.fabricmc.net/")
        mavenCentral()
    }
}

rootProject.name = "mcbot-fabric-client"

if (!JavaVersion.current().isCompatibleWith(JavaVersion.VERSION_21)) {
    throw GradleException(
        "mcbot-fabric-client requires Gradle to run on Java 21+. " +
            "Install JDK 21 and point Gradle at it (e.g. set JAVA_HOME or org.gradle.java.home)."
    )
}
