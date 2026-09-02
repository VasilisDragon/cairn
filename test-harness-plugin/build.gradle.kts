import java.security.MessageDigest

plugins {
    java
}

group = "com.mcbot"
version = "0.1.0"

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}

val pinnedPaperApiVersion = "1.21.11-R0.1-20260511.115010-91"
val pinnedPaperApiSha256 = "c577b181c11a8674310e56c92a91e31c010b7f04c9bd10b91c3be18374401070"
val pinnedPaperApi = "io.papermc.paper:paper-api:$pinnedPaperApiVersion"

val pinnedPaperApiCompileDependencies = listOf(
    "com.google.guava:guava:33.3.1-jre",
    "com.google.code.gson:gson:2.11.0",
    "org.yaml:snakeyaml:2.2",
    "org.joml:joml:1.10.8",
    "it.unimi.dsi:fastutil:8.5.15",
    "org.apache.logging.log4j:log4j-api:2.24.1",
    "org.slf4j:slf4j-api:2.0.16",
    "com.mojang:brigadier:1.3.10",
    "net.md-5:bungeecord-chat:1.21-R0.2-deprecated+build.21",
    "org.apache.maven:maven-resolver-provider:3.9.6",
    "org.jspecify:jspecify:1.0.0",
    "net.kyori:adventure-api:4.26.1",
    "net.kyori:adventure-text-minimessage:4.26.1",
    "net.kyori:adventure-text-serializer-gson:4.26.1",
    "net.kyori:adventure-text-serializer-legacy:4.26.1",
    "net.kyori:adventure-text-serializer-plain:4.26.1",
    "net.kyori:adventure-text-logger-slf4j:4.26.1",
    "org.checkerframework:checker-qual:3.49.2"
)

dependencies {
    compileOnly(pinnedPaperApi) {
        isTransitive = false
    }
    testImplementation(pinnedPaperApi) {
        isTransitive = false
    }
    pinnedPaperApiCompileDependencies.forEach { coordinate ->
        compileOnly(coordinate)
        testImplementation(coordinate)
    }
    testRuntimeOnly("org.apache.maven.resolver:maven-resolver-connector-basic:1.9.18")
    testRuntimeOnly("org.apache.maven.resolver:maven-resolver-transport-http:1.9.18")
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.4")
    testImplementation("org.mockito:mockito-core:5.14.2")
}

tasks.test {
    useJUnitPlatform()
    maxParallelForks = 1
    maxHeapSize = "1G"
    jvmArgs(
        "-XX:+UseSerialGC",
        "-XX:ActiveProcessorCount=2",
        "-XX:CICompilerCount=2",
        "-Djava.util.concurrent.ForkJoinPool.common.parallelism=1"
    )
}

tasks.register("prepareBaselineDependencies") {
    group = "verification"
    description = "Compile tests and resolve the complete runtime classpath for an offline baseline"
    dependsOn(tasks.named("testClasses"))
    doLast {
        check(configurations.getByName("testRuntimeClasspath").files.isNotEmpty()) {
            "Expected the Paper test runtime classpath to contain pinned artifacts"
        }
    }
}

dependencyLocking {
    lockAllConfigurations()
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
    options.release.set(21)
    doFirst {
        val paperApiArtifacts = project.configurations.getByName("compileClasspath")
            .resolvedConfiguration.resolvedArtifacts
            .filter { artifact ->
                artifact.moduleVersion.id.group == "io.papermc.paper" &&
                    artifact.name == "paper-api" &&
                    artifact.moduleVersion.id.version == pinnedPaperApiVersion
            }
        check(paperApiArtifacts.size == 1) {
            "Expected exactly one pinned Paper API artifact, found ${paperApiArtifacts.size}"
        }

        val digest = MessageDigest.getInstance("SHA-256")
        paperApiArtifacts.single().file.inputStream().use { input ->
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        val actualSha256 = digest.digest().joinToString("") { byte ->
            "%02x".format(byte.toInt() and 0xff)
        }
        check(actualSha256 == pinnedPaperApiSha256) {
            "Pinned Paper API checksum mismatch"
        }
    }
}

tasks.processResources {
    filesMatching("plugin.yml") {
        expand("version" to project.version)
    }
}

tasks.jar {
    archiveBaseName.set("mcbot-test-harness")
    doFirst {
        project.delete(layout.projectDirectory.dir("dist"))
    }
}

tasks.clean {
    delete(layout.projectDirectory.dir("dist"))
}
