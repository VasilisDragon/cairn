package com.mcbot.fabricclient;

final class DescentStepSafetyPolicy {
    private DescentStepSafetyPolicy() {
    }

    enum Kind {
        SAFE,
        SUPPORT_WATER,
        BODY_WATER,
        SUPPORT_MISSING,
        HAZARD,
        ADJACENT_WATER,
        ADJACENT_LAVA
    }

    record Hazard(String kind, String cell) {
        Hazard {
            kind = normalize(kind);
            cell = normalize(cell);
        }

        boolean isWater() {
            return "water".equalsIgnoreCase(kind);
        }
    }

    record Observation(
        String supportCell,
        boolean supportStable,
        boolean supportWater,
        Hazard bodyHazard,
        String adjacentWaterCell,
        String adjacentLavaCell
    ) {
        Observation {
            supportCell = normalize(supportCell);
            adjacentWaterCell = normalize(adjacentWaterCell);
            adjacentLavaCell = normalize(adjacentLavaCell);
        }
    }

    record Result(Kind kind, String hazardKind, String cell) {
        Result {
            kind = kind == null ? Kind.SAFE : kind;
            hazardKind = normalize(hazardKind);
            cell = normalize(cell);
        }

        boolean safe() {
            return kind == Kind.SAFE;
        }

        String reason() {
            return switch (kind) {
                case SAFE -> null;
                case SUPPORT_WATER, BODY_WATER, ADJACENT_WATER -> "descent_water_adjacent:" + cell;
                case SUPPORT_MISSING -> "descent_next_support_missing:" + cell;
                case HAZARD -> "descent_hazard_in_step:" + hazardKind + ":" + cell;
                case ADJACENT_LAVA -> "descent_lava_adjacent:" + cell;
            };
        }
    }

    static Result classify(Observation observation) {
        if (observation == null) {
            return new Result(Kind.SAFE, "", "");
        }
        if (observation.supportWater()) {
            return new Result(Kind.SUPPORT_WATER, "water", observation.supportCell());
        }
        Hazard bodyHazard = observation.bodyHazard();
        if (bodyHazard != null && bodyHazard.isWater()) {
            return new Result(Kind.BODY_WATER, bodyHazard.kind(), bodyHazard.cell());
        }
        if (!observation.supportStable()) {
            return new Result(Kind.SUPPORT_MISSING, "", observation.supportCell());
        }
        if (bodyHazard != null) {
            return new Result(Kind.HAZARD, bodyHazard.kind(), bodyHazard.cell());
        }
        if (!observation.adjacentWaterCell().isEmpty()) {
            return new Result(Kind.ADJACENT_WATER, "water", observation.adjacentWaterCell());
        }
        if (!observation.adjacentLavaCell().isEmpty()) {
            return new Result(Kind.ADJACENT_LAVA, "lava", observation.adjacentLavaCell());
        }
        return new Result(Kind.SAFE, "", "");
    }

    private static String normalize(String value) {
        return value == null ? "" : value.trim();
    }
}
