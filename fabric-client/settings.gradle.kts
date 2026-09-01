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

if (JavaVersion.current() != JavaVersion.VERSION_21) {
    throw GradleException(
        "mcbot-fabric-client requires Gradle to run on Java 21. " +
            "Set JAVA_HOME to a JDK 21 installation before invoking the wrapper."
    )
}
