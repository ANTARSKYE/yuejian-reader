package com.yuejian.reader;

import org.w3c.dom.Document;

import java.nio.charset.StandardCharsets;

/** Small host-side regression check for EPUB XML parsing compatibility. */
public final class SafeXmlRegression {
    public static void main(String[] args) throws Exception {
        String container = "<?xml version=\"1.0\"?>"
                + "<container xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\">"
                + "<rootfiles><rootfile full-path=\"OPS/content.opf\"/></rootfiles></container>";
        Document parsed = SafeXml.parse(container.getBytes(StandardCharsets.UTF_8));
        require("container".equals(parsed.getDocumentElement().getLocalName()), "container.xml parse failed");

        String ncx = "<?xml version=\"1.0\"?>"
                + "<!DOCTYPE ncx SYSTEM \"https://example.invalid/ncx-2005-1.dtd\">"
                + "<ncx xmlns=\"http://www.daisy.org/z3986/2005/ncx/\"><navMap/></ncx>";
        parsed = SafeXml.parse(ncx.getBytes(StandardCharsets.UTF_8));
        require("ncx".equals(parsed.getDocumentElement().getLocalName()), "NCX DOCTYPE parse failed");

        String unsafe = "<!DOCTYPE x [<!ENTITY payload SYSTEM \"file:///etc/passwd\">]><x>&payload;</x>";
        try {
            SafeXml.parse(unsafe.getBytes(StandardCharsets.UTF_8));
            throw new AssertionError("unsafe entity declaration was accepted");
        } catch (IllegalArgumentException expected) {
            require(expected.getMessage().contains("不安全"), "unexpected entity rejection message");
        }
        System.out.println("SafeXml EPUB regression passed");
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private SafeXmlRegression() {}
}
