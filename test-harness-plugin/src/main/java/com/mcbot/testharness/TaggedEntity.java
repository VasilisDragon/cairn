package com.mcbot.testharness;

import java.util.UUID;

record TaggedEntity(String token, UUID uuid, String tag, String entityType) {
}
