# VDAB robots.txt

User-agent: *
######################
# OLD DRUPAL PATHS (clean)
######################
Disallow: /index$
Disallow: /node/
Disallow: /search/
Disallow: /user/
Disallow: /gebruiker/
Disallow: /devel/
Disallow: /toolbar/
Disallow: /logout$
Disallow: /login$
Disallow: /feed$
Disallow: /rss.xml$
Disallow: /comment
Disallow: /taxonomy/autocomplete
Disallow: /autocomplete
Disallow: /promoblock/
Disallow: /test-jezelf/*/take
#######################
# WEB PATHS (clean)
#######################
Disallow: /documentatie
Disallow: /carousel
Disallow: /carousel-item
Disallow: /event_session
Disallow: /geen-toegang
Disallow: /pagina-niet-gevonden
Disallow: /tv-zoeken/
Disallow: /zoeken/
Disallow: /leerplekken
Disallow: /headerfooter
Disallow: /include/vacature/
Disallow: /api/vindeenjob/
Disallow: /vac/
Disallow: /prive/
Disallow: /mlb/prive/
Disallow: /vindeenjob/prive/
Disallow: /mijnvdab/
Disallow: /dossiermanager/
######################
# WEB TAXONOMY
######################
Disallow: /blogtype$
Disallow: /event_audience$
Disallow: /event_category$
Disallow: /faq_category$
Disallow: /faq_target_audience$
Disallow: /group_content_types$
Disallow: /tags$
Disallow: /magazine_category$
Disallow: /magazine_text_color$
Disallow: /pagina_class$
Disallow: /profession$
Disallow: /vdab_block_tags$
Disallow: /video_categorie$
Disallow: /video_tags$
Disallow: /video_type$
Disallow: /taxonomy/
#######################
# OLD WEB PATHS (clean)
#######################
Disallow: /dist_channel/
Disallow: /forms/
Disallow: /images/
Disallow: /lib/
Disallow: /metriweb/
Disallow: /style/
Disallow: /utils/
Disallow: /vacatures/
Disallow: /werkwinkel/
Disallow: /toolbox/
Disallow: /nonstop/
Disallow: /nonstopsecure/
Disallow: /verkenner/
Disallow: /*.ics$
Disallow: /*jsessionid=*
Disallow: /*sess=*
Disallow: /*action=*
# Directories
Disallow: /core/
Disallow: /profiles/
Disallow: /backstopjs/
# Files
Disallow: /README.md
Disallow: /composer/Metapackage/README.txt
Disallow: /composer/Plugin/ProjectMessage/README.md
Disallow: /composer/Plugin/Scaffold/README.md
Disallow: /composer/Plugin/VendorHardening/README.txt
Disallow: /composer/Template/README.txt
Disallow: /modules/README.txt
Disallow: /sites/README.txt
Disallow: /themes/README.txt
Disallow: /web.config
Disallow: /update.php
# Paths (clean URLs)
Disallow: /admin/
Disallow: /comment/reply/
Disallow: /filter/tips
Disallow: /node/add/
Disallow: /search/
Disallow: /user/register
Disallow: /user/password
Disallow: /user/login
Disallow: /user/logout
Disallow: /media/oembed
Disallow: /*/media/oembed
# Paths (no clean URLs)
Disallow: /index.php/admin/
Disallow: /index.php/comment/reply/
Disallow: /index.php/filter/tips
Disallow: /index.php/node/add/
Disallow: /index.php/search/
Disallow: /index.php/user/password
Disallow: /index.php/user/register
Disallow: /index.php/user/login
Disallow: /index.php/user/logout
Disallow: /index.php/media/oembed
Disallow: /index.php/*/media/oembed

User-agent: Baiduspider
User-agent: Baiduspider-video
User-agent: Baiduspider-image
Disallow: /

Sitemap: https://www.vdab.be/sitemap.xml
Sitemap: https://www.vdab.be/vindeenopleiding/opleidingen/nc/sitemap/sitemap.xml
Sitemap: https://www.vdab.be/sitemap/vindeenjob/vacatures/index.xml
Sitemap: https://www.vdab.be/sitemap/vindeenjob/index.xml
Sitemap: https://www.vdab.be/vindeenjob/jobs/nc/sitemap/sitemap.xml
Sitemap: https://www.vdab.be/sitemap/beroepen/index.xml