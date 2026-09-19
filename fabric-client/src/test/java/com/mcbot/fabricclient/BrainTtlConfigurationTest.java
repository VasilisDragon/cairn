package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/** Tests the actual client configuration in isolated JVMs, without starting a client. */
final class BrainTtlConfigurationTest {
    private static final String PROPERTY = "mcbot.brainMaxTtlMs";
    private static final String ENVIRONMENT = "MCBOT_FABRIC_BRAIN_MAX_TTL_MS";

    @TempDir
    Path temporaryDirectory;

    static Stream<Arguments> environmentCases() {
        return Stream.of(
            Arguments.of(null, 500L),
            Arguments.of("", 500L),
            Arguments.of("   ", 500L),
            Arguments.of("255000", 255_000L),
            Arguments.of(" 255000 ", 255_000L),
            Arguments.of("0", 500L),
            Arguments.of("-1", 500L),
            Arguments.of("invalid", 500L),
            Arguments.of("9223372036854775808", 500L)
        );
    }

    @ParameterizedTest
    @MethodSource("environmentCases")
    void actualClientResolverAndCapRespectIsolatedEnvironment(String environment, long expected) throws Exception {
        Path output = temporaryDirectory.resolve("probe.log");
        Path arguments = temporaryDirectory.resolve("probe.args");
        // An argument file keeps the full existing test runtime portable across Windows command limits.
        Files.writeString(arguments, "-cp\n" + quoteArgument(runtimeClassPath()) + "\n"
            + BrainTtlConfigurationTest.class.getName() + "\nprobe\n" + expected + "\n");
        String executable = System.getProperty("os.name").startsWith("Windows") ? "java.exe" : "java";
        ProcessBuilder builder = new ProcessBuilder(
            Path.of(System.getProperty("java.home"), "bin", executable).toString(),
            "-Xmx256m", "-XX:+UseSerialGC", "-XX:ActiveProcessorCount=1", "@" + arguments
        ).redirectErrorStream(true).redirectOutput(output.toFile());
        builder.environment().keySet().removeIf(key -> key.startsWith("MCBOT_")
            || Set.of("JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS").contains(key));
        if (environment != null) builder.environment().put(ENVIRONMENT, environment);

        Process process = builder.start();
        try {
            assertTrue(process.waitFor(30L, TimeUnit.SECONDS), "configuration probe exceeded its bound");
            String result = Files.readString(output);
            assertEquals(0, process.exitValue(), result);
            assertTrue(result.contains("brain-ttl-configuration-passed"), result);
        } finally {
            if (process.isAlive()) {
                process.destroyForcibly();
                assertTrue(process.waitFor(5L, TimeUnit.SECONDS), "configuration probe did not stop");
            }
        }
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 2 || !"probe".equals(args[0])) throw new IllegalArgumentException("probe arguments");
        long environmentValue = Long.parseLong(args[1]);
        Method resolver = McbotFabricClient.class.getDeclaredMethod(
            "resolveLong", String.class, String.class, long.class);
        resolver.setAccessible(true);
        String previous = System.getProperty(PROPERTY);
        try {
            verifyResolution(resolver, null, environmentValue);
            // Verify the real startup field uses this resolver, setting name and 500 ms fallback.
            Field configuredCap = McbotFabricClient.class.getDeclaredField("BRAIN_MAX_TTL_MS");
            configuredCap.setAccessible(true);
            requireEqual(environmentValue, configuredCap.getLong(null), "startup cap");

            verifyResolution(resolver, "", environmentValue);
            verifyResolution(resolver, "   ", environmentValue);
            verifyResolution(resolver, "255000", 255_000L);
            verifyResolution(resolver, " 255000 ", 255_000L);
            // A lower JVM property still wins over a higher environment cap. The separate brain
            // process cannot inspect this override; the client continues enforcing its own cap.
            verifyResolution(resolver, "500", 500L);
            for (String invalid : new String[] {"0", "-1", "invalid", "9223372036854775808"}) {
                verifyResolution(resolver, invalid, 500L);
            }
        } finally {
            if (previous == null) System.clearProperty(PROPERTY);
            else System.setProperty(PROPERTY, previous);
        }
        System.out.println("brain-ttl-configuration-passed");
    }

    private static void verifyResolution(Method resolver, String property, long expected) throws Exception {
        if (property == null) System.clearProperty(PROPERTY);
        else System.setProperty(PROPERTY, property);
        long actual = (long) resolver.invoke(null, PROPERTY, ENVIRONMENT, 500L);
        requireEqual(expected, actual, "resolved cap for property " + property);
        BrainLink link = new BrainLink("configuration-probe", body -> "unused", 100L, actual);
        try {
            BrainLink.Intent intent = link.parse("instanceId:configuration-probe\n"
                + "{\"action\":\"descend_staircase\",\"ttlMs\":255000,"
                + "\"reason\":\"mission:DESCEND\",\"commandId\":\"mission-configuration\"}\n", 1_000L);
            requireEqual(1_000L + expected, intent.expiresAtMs(), "client clamp");
            if (!intent.isFresh(999L + expected) || intent.isFresh(1_000L + expected)) {
                throw new AssertionError("client freshness boundary");
            }
        } finally {
            link.shutdown();
        }
    }

    private static void requireEqual(long expected, long actual, String label) {
        if (expected != actual) throw new AssertionError(label + ": expected " + expected + ", got " + actual);
    }

    private static String runtimeClassPath() throws Exception {
        LinkedHashSet<String> paths = new LinkedHashSet<>();
        for (ClassLoader start : new ClassLoader[] {
            BrainTtlConfigurationTest.class.getClassLoader(), Thread.currentThread().getContextClassLoader()
        }) {
            for (ClassLoader loader = start; loader != null; loader = loader.getParent()) {
                if (loader instanceof URLClassLoader urls) {
                    for (URL url : urls.getURLs()) {
                        if ("file".equals(url.getProtocol())) paths.add(Path.of(url.toURI()).toString());
                    }
                }
            }
        }
        for (String path : System.getProperty("java.class.path").split(File.pathSeparator)) {
            if (!path.isBlank()) paths.add(path);
        }
        return String.join(File.pathSeparator, paths);
    }

    private static String quoteArgument(String value) {
        return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }
}
