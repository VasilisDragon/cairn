pluginManagement {
    repositories {
        gradlePluginPortal()
        maven("https://repo.papermc.io/repository/maven-public/")
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        exclusiveContent {
            forRepository {
                ivy {
                    name = "pinnedPaperApi"
                    url = uri("https://repo.papermc.io/repository/maven-public/")
                    patternLayout {
                        artifact(
                            "io/papermc/paper/paper-api/1.21.11-R0.1-SNAPSHOT/" +
                                "[artifact]-[revision].[ext]"
                        )
                    }
                    metadataSources {
                        artifact()
                    }
                }
            }
            filter {
                includeModule("io.papermc.paper", "paper-api")
            }
        }
        mavenCentral()
        maven("https://repo.papermc.io/repository/maven-public/")
    }
}

rootProject.name = "mcbot-test-harness"
