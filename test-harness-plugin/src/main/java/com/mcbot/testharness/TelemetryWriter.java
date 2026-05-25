package com.mcbot.testharness;

import java.io.BufferedWriter;
import java.io.IOException;
import java.util.Iterator;
import java.util.Map;

final class TelemetryWriter {
    private final BufferedWriter writer;
    private boolean closed = false;

    TelemetryWriter(BufferedWriter writer) {
        this.writer = writer;
    }

    synchronized void write(Map<String, Object> event) throws IOException {
        if (closed) {
            throw new IOException("telemetry writer already closed");
        }
        writer.write(toJson(event));
        writer.newLine();
        writer.flush();
    }

    synchronized void close(String reason) throws IOException {
        if (closed) {
            return;
        }
        closed = true;
        writer.flush();
        writer.close();
    }

    private static String toJson(Object value) {
        if (value == null) {
            return "null";
        }
        if (value instanceof String text) {
            return quote(text);
        }
        if (value instanceof Double number && !Double.isFinite(number)) {
            return "null";
        }
        if (value instanceof Float number && !Float.isFinite(number)) {
            return "null";
        }
        if (value instanceof Number || value instanceof Boolean) {
            return String.valueOf(value);
        }
        if (value instanceof Map<?, ?> map) {
            StringBuilder out = new StringBuilder("{");
            Iterator<? extends Map.Entry<?, ?>> iterator = map.entrySet().iterator();
            while (iterator.hasNext()) {
                Map.Entry<?, ?> entry = iterator.next();
                out.append(quote(String.valueOf(entry.getKey()))).append(':').append(toJson(entry.getValue()));
                if (iterator.hasNext()) {
                    out.append(',');
                }
            }
            return out.append('}').toString();
        }
        if (value instanceof Iterable<?> iterable) {
            StringBuilder out = new StringBuilder("[");
            Iterator<?> iterator = iterable.iterator();
            while (iterator.hasNext()) {
                out.append(toJson(iterator.next()));
                if (iterator.hasNext()) {
                    out.append(',');
                }
            }
            return out.append(']').toString();
        }
        return quote(String.valueOf(value));
    }

    private static String quote(String value) {
        StringBuilder out = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i += 1) {
            char ch = value.charAt(i);
            switch (ch) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (ch < 0x20) {
                        out.append(String.format("\\u%04x", (int) ch));
                    } else {
                        out.append(ch);
                    }
                }
            }
        }
        return out.append('"').toString();
    }
}
