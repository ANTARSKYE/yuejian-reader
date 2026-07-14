package com.yuejian.reader;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;
import org.w3c.dom.Document;

import java.nio.charset.StandardCharsets;

public class SafeXmlTest {
    @Test public void parsesOrdinaryEpubContainer() throws Exception {
        String xml = "<?xml version=\"1.0\"?><container xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\"><rootfiles><rootfile full-path=\"OPS/content.opf\"/></rootfiles></container>";
        Document document = SafeXml.parse(xml.getBytes(StandardCharsets.UTF_8));
        assertEquals("container", document.getDocumentElement().getLocalName());
    }

    @Test public void permitsNcxDoctypeWithoutLoadingIt() throws Exception {
        String xml = "<?xml version=\"1.0\"?><!DOCTYPE ncx SYSTEM \"https://example.invalid/ncx.dtd\"><ncx xmlns=\"http://www.daisy.org/z3986/2005/ncx/\"><navMap/></ncx>";
        Document document = SafeXml.parse(xml.getBytes(StandardCharsets.UTF_8));
        assertEquals("ncx", document.getDocumentElement().getLocalName());
    }

    @Test public void rejectsExternalEntities() throws Exception {
        String xml = "<!DOCTYPE x [<!ENTITY payload SYSTEM \"file:///etc/passwd\">]><x>&payload;</x>";
        try {
            SafeXml.parse(xml.getBytes(StandardCharsets.UTF_8));
            fail("unsafe entity declaration was accepted");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("不安全"));
        }
    }
}
