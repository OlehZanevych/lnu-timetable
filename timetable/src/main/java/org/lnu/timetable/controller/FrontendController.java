package org.lnu.timetable.controller;

import org.springframework.boot.autoconfigure.condition.ConditionalOnBooleanProperty;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.ResponseBody;

/**
 * Serves the built Angular client, so that one jar carries both halves of the system and can be
 * deployed as a single artifact. {@code scripts/build-ui.sh} is what puts the bundle in place, under
 * {@code src/main/resources/static/}; {@code scripts/build-app.sh} runs that and then packages the jar.
 *
 * <p>Registered when {@code app.apollo-sandbox.enabled} is {@code false} or absent — i.e. exactly
 * when {@link IndexController} is not, so "/" has one owner either way.
 *
 * <p>The bundle's own files — {@code main-*.js}, {@code styles-*.css}, {@code favicon.ico},
 * {@code fonts/*.ttf} — are already served by Spring Boot's static resource handling from
 * {@code classpath:/static/}, and this controller deliberately leaves them to it. What that handling
 * does <em>not</em> do is answer a deep link: the Angular router owns paths like {@code /faculty/3}
 * and {@code /e/course}, which exist only in the browser, so a reload or a pasted URL asks this
 * service for a file that was never on disk. This controller answers those with {@code index.html}
 * and lets the router take it from there.
 *
 * <p>Three things keep it from swallowing anything it shouldn't:
 * <ul>
 *   <li>each path segment is matched as {@code [^.]*}, so any request for a name containing a dot
 *       (every hashed asset, every font) fails to match here and falls through to the static
 *       resource handler, which has a real file to serve — and still 404s when it does not, rather
 *       than returning HTML where a script was asked for;</li>
 *   <li>{@code /graphql} and {@code /graphiql} are served by Spring for GraphQL's own
 *       {@code RouterFunction}, whose handler mapping is ordered -1 — ahead of the order-0 mapping
 *       that serves annotated controllers like this one — so they are matched before these patterns
 *       are ever consulted;</li>
 *   <li>{@code produces = text/html} keeps it out of the way of anything negotiating for JSON.</li>
 * </ul>
 *
 * <p>Three segments is one more than any route in the client's {@code app.routes.ts} needs today
 * ({@code /faculty/:id} is the deepest). A deeper route added later needs another pattern here.
 */
@Controller
@ConditionalOnBooleanProperty(name = "app.apollo-sandbox.enabled", havingValue = false, matchIfMissing = true)
public class FrontendController {

    private static final Resource INDEX_HTML = new ClassPathResource("static/index.html");

    /**
     * Serve the Angular entry point for the application root and for every client-side route.
     */
    @GetMapping(
        value = {
            "/",
            "/{first:[^.]*}",
            "/{first:[^.]*}/{second:[^.]*}",
            "/{first:[^.]*}/{second:[^.]*}/{third:[^.]*}"
        },
        produces = MediaType.TEXT_HTML_VALUE
    )
    @ResponseBody
    public Resource index() {
        return INDEX_HTML;
    }
}
