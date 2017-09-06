#!/usr/bin/env bash

set -e

ulimit -n 1024

rm -f /var/lib/rabbitmq/.erlang.cookie
echo $ERLANG_COOKIE > /var/lib/rabbitmq/.erlang.cookie
chmod 600 /var/lib/rabbitmq/.erlang.cookie

echo "clustered: $CLUSTERED"

if [ -z "$CLUSTERED" ]; then
	# if not clustered then start it normally as if it is a single server
    rabbitmq-server -detached
else
  echo "clustered_with: $CLUSTER_WITH"
	if [ -z "$CLUSTER_WITH" ]; then
		# If clustered, but cluster with is not specified then again start normally, could be the first server in the
		# cluster
        rabbitmq-server -detached
	else
        rabbitmq-server -detached

        host=`hostname`
        # Don't cluster with self
        echo "sleeping 10 before joining cluster."
        sleep 10

        if ! [[ $CLUSTER_WITH =~ $host ]]; then
            echo "not myself"
            rabbitmqctl stop_app
            if [ -z "$RAM_NODE" ]; then
               rabbitmqctl join_cluster ${CLUSTER_WITH}.${POD_NAMESPACE}.svc.cluster.local
            else
               rabbitmqctl join_cluster --ram ${CLUSTER_WITH}.${POD_NAMESPACE}.svc.cluster.local
            fi
            rabbitmqctl start_app
        fi
	fi
fi

if [ -n "$RABBITMQ_USERNAME" -a -n "$RABBITMQ_PASSWORD" -a -n "$RABBITMQ_VHOST" ]; then
    echo "create_vhost"
    create_vhost() {
        # Check that rabbitmq app is running before adding the vhost otherwise the container will crash
        if [[ `rabbitmqctl status` == *"rabbit,\"RabbitMQ\""* ]]; then
            # create users if provided as env vars
            USER_EXISTS=`rabbitmqctl list_users | { grep $RABBITMQ_USERNAME || true; }`
            # create user only if it doesn't exist
            if [ ! -n "$USER_EXISTS" ]; then
                rabbitmqctl add_user $RABBITMQ_USERNAME $RABBITMQ_PASSWORD
                rabbitmqctl add_vhost $RABBITMQ_VHOST || true
                rabbitmqctl set_permissions -p $RABBITMQ_VHOST $RABBITMQ_USERNAME ".*" ".*" ".*"
                rabbitmqctl set_policy -p $RABBITMQ_VHOST ha-all "" '{"ha-mode":"all","ha-sync-mode":"automatic"}'
            fi
        else
            echo "Waiting for the rabbitmq app to start..."
            sleep 1
            create_vhost
        fi
    }
    create_vhost
fi

rabbitmqctl wait /var/lib/rabbitmq/mnesia/rabbitmq@${host}.pid
