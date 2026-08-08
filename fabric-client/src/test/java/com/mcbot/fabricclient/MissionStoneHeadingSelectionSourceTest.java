package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

final class MissionStoneHeadingSelectionSourceTest {
    private static final Path CLIENT_SOURCE = Path.of(
        "src/main/java/com/mcbot/fabricclient/McbotFabricClient.java");

    @Test
    void initialStonePlanningEvaluatesAllBoundedHeadingsAndInstallsTheWinner() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String method = balancedMethod(source, "private MissionStonePlanningResult planMissionStoneMethod(");

        assertTrue(method.contains("missionStoneCandidateHeadings(run.missionStoneHeading)"));
        assertTrue(method.contains("for (StaircaseDescentPlanner.Direction2d heading : staircaseHeadings)"));
        assertTrue(method.contains("MissionStoneMethodPlanner.selectCandidates(decisions)"));
        assertTrue(method.contains("run.missionStoneHeading = selectedHeading"));
        assertTrue(method.contains("missionStoneShaftActiveForCurrentSession()"));
    }

    private static String balancedMethod(String source, String signature) {
        int start = source.indexOf(signature);
        if (start < 0) {
            throw new AssertionError("missing method: " + signature);
        }
        int brace = source.indexOf('{', start);
        int depth = 0;
        for (int index = brace; index < source.length(); index++) {
            char value = source.charAt(index);
            if (value == '{') depth++;
            if (value == '}' && --depth == 0) {
                return source.substring(start, index + 1);
            }
        }
        throw new AssertionError("unterminated method: " + signature);
    }
}
