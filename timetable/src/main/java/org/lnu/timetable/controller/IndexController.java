package org.lnu.timetable.controller;

import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.reactive.result.view.Rendering;

import java.net.URI;

@Controller
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
