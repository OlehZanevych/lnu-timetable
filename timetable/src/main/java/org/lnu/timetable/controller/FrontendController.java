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
 * does <em>not</em> do is answer a deep link: the Angular router owns paths like
 * {@code /faculty/3/room-assignment} and {@code /room-group}, which exist only in the browser, so a
 * reload or a pasted URL asks this service for a file that was never on disk. This controller
 * answers those with {@code index.html} and lets the router take it from there.
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
 * Those are also the whole of the overlap question: {@link IndexController} is the only other
 * annotated controller in the service and the two are mutually exclusive by construction, so
 * nothing else competes with these patterns for a path.
 *
 * <p><strong>Why the patterns are enumerated rather than one catch-all.</strong> {@code PathPattern}
 * accepts {@code /{*path}}, which would match every depth at once — but it captures the remainder
 * whole, dots and all, so {@code /main-ABC123.js} and {@code /fonts/LiberationSerif.ttf} would match
 * it too. A handler cannot decline a request once its mapping has matched; it would have to serve
 * those files itself, badly, instead of letting the resource handler do it. The per-segment
 * {@code [^.]*} constraint is the only thing that expresses "no dotted name", and a regex constraint
 * is only allowed on a named single-segment capture — so one pattern per depth is the price of the
 * fall-through, and the depth is bounded by however many are listed.
 *
 * <p>Six is well past what the client needs. Its deepest route is three segments — every tabbed
 * drill-down page carries its open tab as one more segment, {@code /faculty/:id/:section}, so that
 * «Кафедри» and «Аудиторії» can be bookmarked and reloaded (see {@code timetable-ui/src/app/
 * app.routes.ts}). A route deeper than six would need one more line here, and nothing else.
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
            "/{s1:[^.]*}",
            "/{s1:[^.]*}/{s2:[^.]*}",
            "/{s1:[^.]*}/{s2:[^.]*}/{s3:[^.]*}",
            "/{s1:[^.]*}/{s2:[^.]*}/{s3:[^.]*}/{s4:[^.]*}",
            "/{s1:[^.]*}/{s2:[^.]*}/{s3:[^.]*}/{s4:[^.]*}/{s5:[^.]*}",
            "/{s1:[^.]*}/{s2:[^.]*}/{s3:[^.]*}/{s4:[^.]*}/{s5:[^.]*}/{s6:[^.]*}"
        },
        produces = MediaType.TEXT_HTML_VALUE
    )
    @ResponseBody
    public Resource index() {
        return INDEX_HTML;
    }
}
