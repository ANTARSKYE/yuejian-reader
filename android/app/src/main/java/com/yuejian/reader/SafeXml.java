package com.yuejian.reader;

import org.w3c.dom.Document;
import org.xml.sax.InputSource;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;

/** XML parser hardened without assuming every Android vendor supports every SAX feature URI. */
final class SafeXml {
    private static final int MAX_XML_BYTES = 8 * 1024 * 1024;

    static Document parse(File file) throws Exception {
        try (InputStream input = new FileInputStream(file)) {
            return parse(readLimited(input));
        }
    }

    static Document parse(byte[] bytes) throws Exception {
        if (bytes.length > MAX_XML_BYTES) {
            throw new IllegalArgumentException("EPUB 目录文件超过 8MB");
        }
        String probe = new String(bytes, StandardCharsets.ISO_8859_1).toUpperCase(Locale.ROOT);
        if (probe.contains("<!ENTITY")) {
            throw new IllegalArgumentException("EPUB 目录包含不安全的实体声明");
        }

        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        factory.setExpandEntityReferences(false);
        try {
            factory.setXIncludeAware(false);
        } catch (Exception | LinkageError ignored) {
            // Some Android vendors do not implement this optional parser capability.
        }
        // Plain DOCTYPE declarations are common in EPUB NCX files. External
        // resolution is blocked below, while entity declarations are rejected above.
        optionalFeature(factory, "http://xml.org/sax/features/external-general-entities", false);
        optionalFeature(factory, "http://xml.org/sax/features/external-parameter-entities", false);
        optionalFeature(factory, "http://apache.org/xml/features/nonvalidating/load-external-dtd", false);
        optionalAttribute(factory, "http://javax.xml.XMLConstants/property/accessExternalDTD", "");
        optionalAttribute(factory, "http://javax.xml.XMLConstants/property/accessExternalSchema", "");

        DocumentBuilder builder = factory.newDocumentBuilder();
        builder.setEntityResolver((publicId, systemId) -> new InputSource(new StringReader("")));
        return builder.parse(new ByteArrayInputStream(bytes));
    }

    private static void optionalFeature(DocumentBuilderFactory factory, String name, boolean value) {
        try {
            factory.setFeature(name, value);
        } catch (Exception | LinkageError ignored) {
            // Parser feature support differs between Android system images.
        }
    }

    private static void optionalAttribute(DocumentBuilderFactory factory, String name, String value) {
        try {
            factory.setAttribute(name, value);
        } catch (Exception | LinkageError ignored) {
            // Android's bundled parser may not expose JAXP 1.5 attributes.
        }
    }

    private static byte[] readLimited(InputStream input) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[16384];
        int read;
        while ((read = input.read(buffer)) >= 0) {
            if (output.size() + read > MAX_XML_BYTES) {
                throw new IllegalArgumentException("EPUB 目录文件超过 8MB");
            }
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }

    private SafeXml() {}
}
