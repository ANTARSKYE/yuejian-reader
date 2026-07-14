package com.yuejian.reader;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class EpubAnchorTest {
    @Test public void findsIdAndNameAnchorsInsteadOfLinks() {
        String html = "<a href=\"#filepos2\">目录链接</a><span id=\"filepos1\">第一节</span>"
                + "<a name='filepos2'></a><p>第二节</p>";
        int first = BookRepository.anchorStart(html, "filepos1");
        int second = BookRepository.anchorStart(html, "filepos2");
        assertTrue(first > html.indexOf("目录链接"));
        assertTrue(second > first);
    }

    @Test public void reportsMissingAnchor() {
        assertEquals(-1, BookRepository.anchorStart("<p>正文</p>", "missing"));
    }
}
