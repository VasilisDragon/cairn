plugins {
    id("fabric-loom") version "1.13.4"
    java
}

version = property("mod_version") as String
group = property("maven_group") as String

base {
    archivesName.set(property("archives_base_name") as String)
}

dependencies {
    minecraft("com.mojang:minecraft:${property("minecraft_version")}")
    mappings("net.fabricmc:yarn:${property("yarn_mappings")}:v2")
    modImplementation("net.fabricmc:fabric-loader:${property("loader_version")}")
    modImplementation("net.fabricmc.fabric-api:fabric-api:${property("fabric_version")}")

    testImplementation("org.junit.jupiter:junit-jupiter:5.11.3")
    testImplementation("com.google.code.gson:gson:2.10.1")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test {
    useJUnitPlatform()
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
    options.release.set(21)
}

tasks.withType<JavaExec>().configureEach {
    val configuredInstanceId = System.getenv("MCBOT_FABRIC_INSTANCE_ID")
    val configuredBrainUrl = System.getenv("MCBOT_FABRIC_BRAIN_URL")
    val quickPlayWorld = System.getenv("MCBOT_FABRIC_QUICKPLAY_SINGLEPLAYER")
    val autoSingleplayer = System.getenv("MCBOT_FABRIC_AUTO_SINGLEPLAYER")
    val autoRespawn = System.getenv("MCBOT_FABRIC_AUTO_RESPAWN")
    val windowWidth = System.getenv("MCBOT_FABRIC_WINDOW_WIDTH")?.takeIf { it.isNotBlank() } ?: "854"
    val windowHeight = System.getenv("MCBOT_FABRIC_WINDOW_HEIGHT")?.takeIf { it.isNotBlank() } ?: "480"
    if (!configuredInstanceId.isNullOrBlank()) {
        systemProperty("mcbot.instanceId", configuredInstanceId)
    }
    if (!configuredBrainUrl.isNullOrBlank()) {
        systemProperty("mcbot.brainUrl", configuredBrainUrl)
    }
    if (!autoSingleplayer.isNullOrBlank()) {
        systemProperty("mcbot.autoSingleplayer", autoSingleplayer)
    }
    if (!autoRespawn.isNullOrBlank()) {
        systemProperty("mcbot.autoRespawn", autoRespawn)
    }
    args("--width", windowWidth, "--height", windowHeight)
    if (!quickPlayWorld.isNullOrBlank()) {
        args("--quickPlaySingleplayer", quickPlayWorld)
    }
}

tasks.processResources {
    inputs.property("version", project.version)
    filesMatching("fabric.mod.json") {
        expand("version" to project.version)
    }
}
