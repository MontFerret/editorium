package org.ferretlang.jetbrains.protocol.ferretd.workspace.v1;

import static io.grpc.MethodDescriptor.generateFullMethodName;

/**
 */
@io.grpc.stub.annotations.GrpcGenerated
public final class WorkspaceServiceGrpc {

  private WorkspaceServiceGrpc() {}

  public static final java.lang.String SERVICE_NAME = "ferretd.workspace.v1.WorkspaceService";

  // Static method descriptors that strictly reflect the proto.
  private static volatile io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.OpenRequest,
      org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.OpenResponse> getOpenMethod;

  @io.grpc.stub.annotations.RpcMethod(
      fullMethodName = SERVICE_NAME + '/' + "Open",
      requestType = org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.OpenRequest.class,
      responseType = org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.OpenResponse.class,
      methodType = io.grpc.MethodDescriptor.MethodType.UNARY)
  public static io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.OpenRequest,
      org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.OpenResponse> getOpenMethod() {
    io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.OpenRequest, org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.OpenResponse> getOpenMethod;
    if ((getOpenMethod = WorkspaceServiceGrpc.getOpenMethod) == null) {
      synchronized (WorkspaceServiceGrpc.class) {
        if ((getOpenMethod = WorkspaceServiceGrpc.getOpenMethod) == null) {
          WorkspaceServiceGrpc.getOpenMethod = getOpenMethod =
              io.grpc.MethodDescriptor.<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.OpenRequest, org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.OpenResponse>newBuilder()
              .setType(io.grpc.MethodDescriptor.MethodType.UNARY)
              .setFullMethodName(generateFullMethodName(SERVICE_NAME, "Open"))
              .setSampledToLocalTracing(true)
              .setRequestMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.OpenRequest.getDefaultInstance()))
              .setResponseMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.OpenResponse.getDefaultInstance()))
              .setSchemaDescriptor(new WorkspaceServiceMethodDescriptorSupplier("Open"))
              .build();
        }
      }
    }
    return getOpenMethod;
  }

  private static volatile io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.GetRequest,
      org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.GetResponse> getGetMethod;

  @io.grpc.stub.annotations.RpcMethod(
      fullMethodName = SERVICE_NAME + '/' + "Get",
      requestType = org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.GetRequest.class,
      responseType = org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.GetResponse.class,
      methodType = io.grpc.MethodDescriptor.MethodType.UNARY)
  public static io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.GetRequest,
      org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.GetResponse> getGetMethod() {
    io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.GetRequest, org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.GetResponse> getGetMethod;
    if ((getGetMethod = WorkspaceServiceGrpc.getGetMethod) == null) {
      synchronized (WorkspaceServiceGrpc.class) {
        if ((getGetMethod = WorkspaceServiceGrpc.getGetMethod) == null) {
          WorkspaceServiceGrpc.getGetMethod = getGetMethod =
              io.grpc.MethodDescriptor.<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.GetRequest, org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.GetResponse>newBuilder()
              .setType(io.grpc.MethodDescriptor.MethodType.UNARY)
              .setFullMethodName(generateFullMethodName(SERVICE_NAME, "Get"))
              .setSampledToLocalTracing(true)
              .setRequestMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.GetRequest.getDefaultInstance()))
              .setResponseMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.GetResponse.getDefaultInstance()))
              .setSchemaDescriptor(new WorkspaceServiceMethodDescriptorSupplier("Get"))
              .build();
        }
      }
    }
    return getGetMethod;
  }

  private static volatile io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.ListRequest,
      org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.ListResponse> getListMethod;

  @io.grpc.stub.annotations.RpcMethod(
      fullMethodName = SERVICE_NAME + '/' + "List",
      requestType = org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.ListRequest.class,
      responseType = org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.ListResponse.class,
      methodType = io.grpc.MethodDescriptor.MethodType.UNARY)
  public static io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.ListRequest,
      org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.ListResponse> getListMethod() {
    io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.ListRequest, org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.ListResponse> getListMethod;
    if ((getListMethod = WorkspaceServiceGrpc.getListMethod) == null) {
      synchronized (WorkspaceServiceGrpc.class) {
        if ((getListMethod = WorkspaceServiceGrpc.getListMethod) == null) {
          WorkspaceServiceGrpc.getListMethod = getListMethod =
              io.grpc.MethodDescriptor.<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.ListRequest, org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.ListResponse>newBuilder()
              .setType(io.grpc.MethodDescriptor.MethodType.UNARY)
              .setFullMethodName(generateFullMethodName(SERVICE_NAME, "List"))
              .setSampledToLocalTracing(true)
              .setRequestMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.ListRequest.getDefaultInstance()))
              .setResponseMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.ListResponse.getDefaultInstance()))
              .setSchemaDescriptor(new WorkspaceServiceMethodDescriptorSupplier("List"))
              .build();
        }
      }
    }
    return getListMethod;
  }

  private static volatile io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.CloseRequest,
      org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.CloseResponse> getCloseMethod;

  @io.grpc.stub.annotations.RpcMethod(
      fullMethodName = SERVICE_NAME + '/' + "Close",
      requestType = org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.CloseRequest.class,
      responseType = org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.CloseResponse.class,
      methodType = io.grpc.MethodDescriptor.MethodType.UNARY)
  public static io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.CloseRequest,
      org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.CloseResponse> getCloseMethod() {
    io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.CloseRequest, org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.CloseResponse> getCloseMethod;
    if ((getCloseMethod = WorkspaceServiceGrpc.getCloseMethod) == null) {
      synchronized (WorkspaceServiceGrpc.class) {
        if ((getCloseMethod = WorkspaceServiceGrpc.getCloseMethod) == null) {
          WorkspaceServiceGrpc.getCloseMethod = getCloseMethod =
              io.grpc.MethodDescriptor.<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.CloseRequest, org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.CloseResponse>newBuilder()
              .setType(io.grpc.MethodDescriptor.MethodType.UNARY)
              .setFullMethodName(generateFullMethodName(SERVICE_NAME, "Close"))
              .setSampledToLocalTracing(true)
              .setRequestMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.CloseRequest.getDefaultInstance()))
              .setResponseMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.CloseResponse.getDefaultInstance()))
              .setSchemaDescriptor(new WorkspaceServiceMethodDescriptorSupplier("Close"))
              .build();
        }
      }
    }
    return getCloseMethod;
  }

  /**
   * Creates a new async stub that supports all call types for the service
   */
  public static WorkspaceServiceStub newStub(io.grpc.Channel channel) {
    io.grpc.stub.AbstractStub.StubFactory<WorkspaceServiceStub> factory =
      new io.grpc.stub.AbstractStub.StubFactory<WorkspaceServiceStub>() {
        @java.lang.Override
        public WorkspaceServiceStub newStub(io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
          return new WorkspaceServiceStub(channel, callOptions);
        }
      };
    return WorkspaceServiceStub.newStub(factory, channel);
  }

  /**
   * Creates a new blocking-style stub that supports all types of calls on the service
   */
  public static WorkspaceServiceBlockingV2Stub newBlockingV2Stub(
      io.grpc.Channel channel) {
    io.grpc.stub.AbstractStub.StubFactory<WorkspaceServiceBlockingV2Stub> factory =
      new io.grpc.stub.AbstractStub.StubFactory<WorkspaceServiceBlockingV2Stub>() {
        @java.lang.Override
        public WorkspaceServiceBlockingV2Stub newStub(io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
          return new WorkspaceServiceBlockingV2Stub(channel, callOptions);
        }
      };
    return WorkspaceServiceBlockingV2Stub.newStub(factory, channel);
  }

  /**
   * Creates a new blocking-style stub that supports unary and streaming output calls on the service
   */
  public static WorkspaceServiceBlockingStub newBlockingStub(
      io.grpc.Channel channel) {
    io.grpc.stub.AbstractStub.StubFactory<WorkspaceServiceBlockingStub> factory =
      new io.grpc.stub.AbstractStub.StubFactory<WorkspaceServiceBlockingStub>() {
        @java.lang.Override
        public WorkspaceServiceBlockingStub newStub(io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
          return new WorkspaceServiceBlockingStub(channel, callOptions);
        }
      };
    return WorkspaceServiceBlockingStub.newStub(factory, channel);
  }

  /**
   * Creates a new ListenableFuture-style stub that supports unary calls on the service
   */
  public static WorkspaceServiceFutureStub newFutureStub(
      io.grpc.Channel channel) {
    io.grpc.stub.AbstractStub.StubFactory<WorkspaceServiceFutureStub> factory =
      new io.grpc.stub.AbstractStub.StubFactory<WorkspaceServiceFutureStub>() {
        @java.lang.Override
        public WorkspaceServiceFutureStub newStub(io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
          return new WorkspaceServiceFutureStub(channel, callOptions);
        }
      };
    return WorkspaceServiceFutureStub.newStub(factory, channel);
  }

  /**
   */
  public interface AsyncService {

    /**
     */
    default void open(org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.OpenRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.OpenResponse> responseObserver) {
      io.grpc.stub.ServerCalls.asyncUnimplementedUnaryCall(getOpenMethod(), responseObserver);
    }

    /**
     */
    default void get(org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.GetRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.GetResponse> responseObserver) {
      io.grpc.stub.ServerCalls.asyncUnimplementedUnaryCall(getGetMethod(), responseObserver);
    }

    /**
     */
    default void list(org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.ListRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.ListResponse> responseObserver) {
      io.grpc.stub.ServerCalls.asyncUnimplementedUnaryCall(getListMethod(), responseObserver);
    }

    /**
     */
    default void close(org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.CloseRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.CloseResponse> responseObserver) {
      io.grpc.stub.ServerCalls.asyncUnimplementedUnaryCall(getCloseMethod(), responseObserver);
    }
  }

  /**
   * Base class for the server implementation of the service WorkspaceService.
   */
  public static abstract class WorkspaceServiceImplBase
      implements io.grpc.BindableService, AsyncService {

    @java.lang.Override public final io.grpc.ServerServiceDefinition bindService() {
      return WorkspaceServiceGrpc.bindService(this);
    }
  }

  /**
   * A stub to allow clients to do asynchronous rpc calls to service WorkspaceService.
   */
  public static final class WorkspaceServiceStub
      extends io.grpc.stub.AbstractAsyncStub<WorkspaceServiceStub> {
    private WorkspaceServiceStub(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      super(channel, callOptions);
    }

    @java.lang.Override
    protected WorkspaceServiceStub build(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      return new WorkspaceServiceStub(channel, callOptions);
    }

    /**
     */
    public void open(org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.OpenRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.OpenResponse> responseObserver) {
      io.grpc.stub.ClientCalls.asyncUnaryCall(
          getChannel().newCall(getOpenMethod(), getCallOptions()), request, responseObserver);
    }

    /**
     */
    public void get(org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.GetRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.GetResponse> responseObserver) {
      io.grpc.stub.ClientCalls.asyncUnaryCall(
          getChannel().newCall(getGetMethod(), getCallOptions()), request, responseObserver);
    }

    /**
     */
    public void list(org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.ListRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.ListResponse> responseObserver) {
      io.grpc.stub.ClientCalls.asyncUnaryCall(
          getChannel().newCall(getListMethod(), getCallOptions()), request, responseObserver);
    }

    /**
     */
    public void close(org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.CloseRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.CloseResponse> responseObserver) {
      io.grpc.stub.ClientCalls.asyncUnaryCall(
          getChannel().newCall(getCloseMethod(), getCallOptions()), request, responseObserver);
    }
  }

  /**
   * A stub to allow clients to do synchronous rpc calls to service WorkspaceService.
   */
  public static final class WorkspaceServiceBlockingV2Stub
      extends io.grpc.stub.AbstractBlockingStub<WorkspaceServiceBlockingV2Stub> {
    private WorkspaceServiceBlockingV2Stub(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      super(channel, callOptions);
    }

    @java.lang.Override
    protected WorkspaceServiceBlockingV2Stub build(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      return new WorkspaceServiceBlockingV2Stub(channel, callOptions);
    }

    /**
     */
    public org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.OpenResponse open(org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.OpenRequest request) throws io.grpc.StatusException {
      return io.grpc.stub.ClientCalls.blockingV2UnaryCall(
          getChannel(), getOpenMethod(), getCallOptions(), request);
    }

    /**
     */
    public org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.GetResponse get(org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.GetRequest request) throws io.grpc.StatusException {
      return io.grpc.stub.ClientCalls.blockingV2UnaryCall(
          getChannel(), getGetMethod(), getCallOptions(), request);
    }

    /**
     */
    public org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.ListResponse list(org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.ListRequest request) throws io.grpc.StatusException {
      return io.grpc.stub.ClientCalls.blockingV2UnaryCall(
          getChannel(), getListMethod(), getCallOptions(), request);
    }

    /**
     */
    public org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.CloseResponse close(org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.CloseRequest request) throws io.grpc.StatusException {
      return io.grpc.stub.ClientCalls.blockingV2UnaryCall(
          getChannel(), getCloseMethod(), getCallOptions(), request);
    }
  }

  /**
   * A stub to allow clients to do limited synchronous rpc calls to service WorkspaceService.
   */
  public static final class WorkspaceServiceBlockingStub
      extends io.grpc.stub.AbstractBlockingStub<WorkspaceServiceBlockingStub> {
    private WorkspaceServiceBlockingStub(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      super(channel, callOptions);
    }

    @java.lang.Override
    protected WorkspaceServiceBlockingStub build(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      return new WorkspaceServiceBlockingStub(channel, callOptions);
    }

    /**
     */
    public org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.OpenResponse open(org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.OpenRequest request) {
      return io.grpc.stub.ClientCalls.blockingUnaryCall(
          getChannel(), getOpenMethod(), getCallOptions(), request);
    }

    /**
     */
    public org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.GetResponse get(org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.GetRequest request) {
      return io.grpc.stub.ClientCalls.blockingUnaryCall(
          getChannel(), getGetMethod(), getCallOptions(), request);
    }

    /**
     */
    public org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.ListResponse list(org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.ListRequest request) {
      return io.grpc.stub.ClientCalls.blockingUnaryCall(
          getChannel(), getListMethod(), getCallOptions(), request);
    }

    /**
     */
    public org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.CloseResponse close(org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.CloseRequest request) {
      return io.grpc.stub.ClientCalls.blockingUnaryCall(
          getChannel(), getCloseMethod(), getCallOptions(), request);
    }
  }

  /**
   * A stub to allow clients to do ListenableFuture-style rpc calls to service WorkspaceService.
   */
  public static final class WorkspaceServiceFutureStub
      extends io.grpc.stub.AbstractFutureStub<WorkspaceServiceFutureStub> {
    private WorkspaceServiceFutureStub(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      super(channel, callOptions);
    }

    @java.lang.Override
    protected WorkspaceServiceFutureStub build(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      return new WorkspaceServiceFutureStub(channel, callOptions);
    }

    /**
     */
    public com.google.common.util.concurrent.ListenableFuture<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.OpenResponse> open(
        org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.OpenRequest request) {
      return io.grpc.stub.ClientCalls.futureUnaryCall(
          getChannel().newCall(getOpenMethod(), getCallOptions()), request);
    }

    /**
     */
    public com.google.common.util.concurrent.ListenableFuture<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.GetResponse> get(
        org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.GetRequest request) {
      return io.grpc.stub.ClientCalls.futureUnaryCall(
          getChannel().newCall(getGetMethod(), getCallOptions()), request);
    }

    /**
     */
    public com.google.common.util.concurrent.ListenableFuture<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.ListResponse> list(
        org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.ListRequest request) {
      return io.grpc.stub.ClientCalls.futureUnaryCall(
          getChannel().newCall(getListMethod(), getCallOptions()), request);
    }

    /**
     */
    public com.google.common.util.concurrent.ListenableFuture<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.CloseResponse> close(
        org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.CloseRequest request) {
      return io.grpc.stub.ClientCalls.futureUnaryCall(
          getChannel().newCall(getCloseMethod(), getCallOptions()), request);
    }
  }

  private static final int METHODID_OPEN = 0;
  private static final int METHODID_GET = 1;
  private static final int METHODID_LIST = 2;
  private static final int METHODID_CLOSE = 3;

  private static final class MethodHandlers<Req, Resp> implements
      io.grpc.stub.ServerCalls.UnaryMethod<Req, Resp>,
      io.grpc.stub.ServerCalls.ServerStreamingMethod<Req, Resp>,
      io.grpc.stub.ServerCalls.ClientStreamingMethod<Req, Resp>,
      io.grpc.stub.ServerCalls.BidiStreamingMethod<Req, Resp> {
    private final AsyncService serviceImpl;
    private final int methodId;

    MethodHandlers(AsyncService serviceImpl, int methodId) {
      this.serviceImpl = serviceImpl;
      this.methodId = methodId;
    }

    @java.lang.Override
    @java.lang.SuppressWarnings("unchecked")
    public void invoke(Req request, io.grpc.stub.StreamObserver<Resp> responseObserver) {
      switch (methodId) {
        case METHODID_OPEN:
          serviceImpl.open((org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.OpenRequest) request,
              (io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.OpenResponse>) responseObserver);
          break;
        case METHODID_GET:
          serviceImpl.get((org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.GetRequest) request,
              (io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.GetResponse>) responseObserver);
          break;
        case METHODID_LIST:
          serviceImpl.list((org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.ListRequest) request,
              (io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.ListResponse>) responseObserver);
          break;
        case METHODID_CLOSE:
          serviceImpl.close((org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.CloseRequest) request,
              (io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.CloseResponse>) responseObserver);
          break;
        default:
          throw new AssertionError();
      }
    }

    @java.lang.Override
    @java.lang.SuppressWarnings("unchecked")
    public io.grpc.stub.StreamObserver<Req> invoke(
        io.grpc.stub.StreamObserver<Resp> responseObserver) {
      switch (methodId) {
        default:
          throw new AssertionError();
      }
    }
  }

  public static final io.grpc.ServerServiceDefinition bindService(AsyncService service) {
    return io.grpc.ServerServiceDefinition.builder(getServiceDescriptor())
        .addMethod(
          getOpenMethod(),
          io.grpc.stub.ServerCalls.asyncUnaryCall(
            new MethodHandlers<
              org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.OpenRequest,
              org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.OpenResponse>(
                service, METHODID_OPEN)))
        .addMethod(
          getGetMethod(),
          io.grpc.stub.ServerCalls.asyncUnaryCall(
            new MethodHandlers<
              org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.GetRequest,
              org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.GetResponse>(
                service, METHODID_GET)))
        .addMethod(
          getListMethod(),
          io.grpc.stub.ServerCalls.asyncUnaryCall(
            new MethodHandlers<
              org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.ListRequest,
              org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.ListResponse>(
                service, METHODID_LIST)))
        .addMethod(
          getCloseMethod(),
          io.grpc.stub.ServerCalls.asyncUnaryCall(
            new MethodHandlers<
              org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.CloseRequest,
              org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.CloseResponse>(
                service, METHODID_CLOSE)))
        .build();
  }

  private static abstract class WorkspaceServiceBaseDescriptorSupplier
      implements io.grpc.protobuf.ProtoFileDescriptorSupplier, io.grpc.protobuf.ProtoServiceDescriptorSupplier {
    WorkspaceServiceBaseDescriptorSupplier() {}

    @java.lang.Override
    public com.google.protobuf.Descriptors.FileDescriptor getFileDescriptor() {
      return org.ferretlang.jetbrains.protocol.ferretd.workspace.v1.WorkspaceProto.getDescriptor();
    }

    @java.lang.Override
    public com.google.protobuf.Descriptors.ServiceDescriptor getServiceDescriptor() {
      return getFileDescriptor().findServiceByName("WorkspaceService");
    }
  }

  private static final class WorkspaceServiceFileDescriptorSupplier
      extends WorkspaceServiceBaseDescriptorSupplier {
    WorkspaceServiceFileDescriptorSupplier() {}
  }

  private static final class WorkspaceServiceMethodDescriptorSupplier
      extends WorkspaceServiceBaseDescriptorSupplier
      implements io.grpc.protobuf.ProtoMethodDescriptorSupplier {
    private final java.lang.String methodName;

    WorkspaceServiceMethodDescriptorSupplier(java.lang.String methodName) {
      this.methodName = methodName;
    }

    @java.lang.Override
    public com.google.protobuf.Descriptors.MethodDescriptor getMethodDescriptor() {
      return getServiceDescriptor().findMethodByName(methodName);
    }
  }

  private static volatile io.grpc.ServiceDescriptor serviceDescriptor;

  public static io.grpc.ServiceDescriptor getServiceDescriptor() {
    io.grpc.ServiceDescriptor result = serviceDescriptor;
    if (result == null) {
      synchronized (WorkspaceServiceGrpc.class) {
        result = serviceDescriptor;
        if (result == null) {
          serviceDescriptor = result = io.grpc.ServiceDescriptor.newBuilder(SERVICE_NAME)
              .setSchemaDescriptor(new WorkspaceServiceFileDescriptorSupplier())
              .addMethod(getOpenMethod())
              .addMethod(getGetMethod())
              .addMethod(getListMethod())
              .addMethod(getCloseMethod())
              .build();
        }
      }
    }
    return result;
  }
}
