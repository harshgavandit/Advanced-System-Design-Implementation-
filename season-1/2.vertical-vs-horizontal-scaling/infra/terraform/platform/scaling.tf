resource "aws_appautoscaling_target" "this" {

  for_each           = toset(["api", "worker"])
  min_capacity       = each.key == "api" ? 2 : 1
  max_capacity       = each.key == "api" ? var.api_max : var.worker_max
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.this[each.key].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"

}

resource "aws_appautoscaling_policy" "api_cpu" {

  name               = "${local.name}-api-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.this["api"].resource_id
  scalable_dimension = aws_appautoscaling_target.this["api"].scalable_dimension
  service_namespace  = "ecs"
  target_tracking_scaling_policy_configuration {

    target_value       = 60
    scale_out_cooldown = 60
    scale_in_cooldown  = 300
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }


  }


}

resource "aws_appautoscaling_policy" "api_requests" {

  name               = "${local.name}-api-requests"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.this["api"].resource_id
  scalable_dimension = aws_appautoscaling_target.this["api"].scalable_dimension
  service_namespace  = "ecs"
  target_tracking_scaling_policy_configuration {

    target_value       = var.requests_per_target_per_minute
    scale_out_cooldown = 60
    scale_in_cooldown  = 300
    predefined_metric_specification {

      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${aws_lb.this.arn_suffix}/${aws_lb_target_group.api.arn_suffix}"

    }


  }


}

resource "aws_appautoscaling_policy" "worker_backlog" {

  name               = "${local.name}-worker-backlog"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.this["worker"].resource_id
  scalable_dimension = aws_appautoscaling_target.this["worker"].scalable_dimension
  service_namespace  = "ecs"
  target_tracking_scaling_policy_configuration {

    target_value       = 20
    scale_out_cooldown = 60
    scale_in_cooldown  = 300
    customized_metric_specification {

      metrics {

        id          = "backlog"
        return_data = false
        metric_stat {

          stat = "Average"
          metric {
            namespace   = "AWS/SQS"
            metric_name = "ApproximateNumberOfMessagesVisible"
            dimensions {
              name  = "QueueName"
              value = aws_sqs_queue.jobs.name
            }

          }


        }


      }

      metrics {

        id          = "workers"
        return_data = false
        metric_stat {

          stat = "Average"
          metric {
            namespace   = "ECS/ContainerInsights"
            metric_name = "RunningTaskCount"
            dimensions {
              name  = "ClusterName"
              value = aws_ecs_cluster.this.name
            }

            dimensions {
              name  = "ServiceName"
              value = aws_ecs_service.this["worker"].name
            }

          }


        }


      }

      metrics {
        id          = "backlog_per_worker"
        expression  = "IF(workers>0,backlog/workers,backlog)"
        return_data = true
      }


    }


  }


}

