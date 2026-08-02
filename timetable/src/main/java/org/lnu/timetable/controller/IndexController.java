package org.lnu.timetable.controller;

import org.springframework.boot.autoconfigure.condition.ConditionalOnBooleanProperty;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.reactive.result.view.Rendering;

import java.net.URI;

/**
 * Development convenience: point a browser at the service root and land in Apollo Studio Sandbox,
 * already aimed at this instance's /graphql endpoint.
 *
 * <p>Only registered when {@code app.apollo-sandbox.enabled} is {@code true} — which is how
 * {@code application-loc.properties} sets it for local development. When the property is
 * {@code false}, absent, or anything that is not {@code true} (a packaged deployment),
 * {@link FrontendController} takes over "/" and serves the Angular client instead. The two are
 * mutually exclusive by construction: exactly one of them is ever in the context.
 */
@Controller
@ConditionalOnBooleanProperty(name = "app.apollo-sandbox.enabled")
public class IndexController {

    /**
     * Redirect to Apollo Studio Sandbox pointed at this service's /graphql endpoint.
     */
    @GetMapping("/")
    public Rendering redirectToApolloStudioSandbox(ServerHttpRequest serverHttpRequest) {
        URI requestUri = serverHttpRequest.getURI();
        String graphQlEndpoint = requestUri.getScheme() + "://" + requestUri.getHost() + ":"
            + requestUri.getPort() + "/graphql";

        return Rendering.redirectTo("https://studio.apollographql.com/sandbox?endpoint=" + graphQlEndpoint).build();
    }
}
