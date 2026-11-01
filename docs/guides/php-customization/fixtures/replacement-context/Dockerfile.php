FROM php:8.3-fpm-bookworm
RUN docker-php-ext-install pdo_mysql
